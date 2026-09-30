# Delivery receipts for Claude wakes

English companion to §6 of [wake-protocol.md](./wake-protocol.md) (the protocol document, written in Chinese, is the source of truth; this page follows it). Since v0.7.0. macOS and Linux.

## The problem

When ocs wakes a Claude Code session it writes a frame to that session's inbox socket. The frame then has to pass the receiver's `crossSessionInbound` gate:

- `accept`: the message goes straight into the conversation.
- `hold` (the **default**; a repo-level setting can also tighten a user-level `accept` to `hold`): the message waits for manual approval and is dropped if nobody approves it within 5 minutes.
- It can also be refused.

The socket write succeeds in all three cases, so before 0.7.0 the sender could not tell them apart. Claude Code has its own receipts for this (`peer_message_status`, observed on 2.1.285, undocumented). ocs now uses them.

## On the wire

When the user frame carries both `from: "uds:<reply socket>"` and `msg_id`, the receiver connects to that socket and writes the fate of the message as JSONL control frames:

```
{"type":"control","action":"peer_message_status","status":"<status>","reason":"…",
 "from":"uds:<receiver socket>","orig_msg_id":"<msg_id of the original>","msgV":1,"msg_id":"…"}
```

| `status` on the wire | ocs calls it | Meaning |
|---|---|---|
| (no receipt at all) | `accepted` | The policy is accept. The receiver sends **nothing** and the message enters the conversation. |
| `held` | `held` | Parked by the gate, waiting for approval. Arrives 30–50 ms after the write. A terminal status follows later. |
| `delivered` | `delivered` | A held message was approved. |
| `expired` | `expired` | The 5-minute timeout, eviction from a full hold buffer, or the receiving session exiting. |
| `expired` + `status_detail:"refused"` | `refused` | Refused. |
| `dropped` (with `drop_reason`) | `dropped` | Queue full. |
| `denied` | `denied` | Denied by policy. |

ocs only accepts frames whose `orig_msg_id` equals its own `msg_id`, and ignores unknown statuses. `reason` is text from the receiver: it is cut to one line of 200 characters and treated as data.

### What a receipt proves

- `held`, `refused`, `dropped`, `denied` and `expired` prove the message did **not** enter the conversation.
- `delivered` proves a held message did.
- `accepted` only means the protocol reported no hold or refusal inside the wait window. It is not a read receipt. It does not prove the peer acted on the message, and it does not prove the receiver is a version that sends receipts. Anything that counts as acknowledgement still has to be the peer's reply.

## Reply address and process model

The receiver checks the reply address in two ways, and both shape the implementation:

1. The path must match `/^\/\S*\.sock$/` and sit in the **same directory** as the receiver's own socket. ocs uses `<target socket dir>/<16 hex>.sock` (for example `/tmp/cc-socks/3f9a…e1.sock`), mode 0600. If that directory is not a real directory, is not owned by the current user, or the path contains whitespace, ocs creates nothing and falls back to the path without receipts.
2. The receipt is sent only to **the process that wrote the message** (checked against the pid in the socket peer credentials). So the process that writes the frame must also listen on the reply socket, and stay alive until the terminal receipt arrives.

That is why each Claude wake is done by a detached helper process (`ocs _claude-wake <job-id>`, an internal command):

1. Open the reply listener, write the frame with `from` and `msg_id`, wait **400 ms** for a first receipt, and print one result line on stdout.
2. No receipt: `accepted`, exit. `refused` / `dropped` / `denied` / `expired` / `delivered`: report it, exit.
3. `held`: keep waiting for the terminal status, for at most **5 minutes + 60 seconds**. If the target session disappears (three failed polls in a row) the wait ends early. No terminal status by the deadline is recorded as `unknown`.
4. A terminal `delivered` is only recorded. Any other terminal status is recorded, the sender is **notified once**, and the helper exits.

The CLI waits up to 1.5 seconds for the helper's first line. If none arrives it reports the outcome as unknown (exit 3). **Only the helper ever writes the frame; the CLI never writes it a second time.** The CLI falls back to writing in-process, without receipts, only when no helper could be started at all.

Creating this one temporary socket file in Claude's socket directory is the single exception to ocs treating Claude's directories as read-only. It is removed before the helper exits. If the helper is killed with SIGKILL, the next wake removes the leftover file using the record in `$OCS_HOME/wake-jobs/`; nothing else in that directory is touched.

## What the sender sees

| First phase | CLI output | Exit |
|---|---|---|
| `accepted` | `wake: accepted by inbox → <target> (no hold/refuse receipt; this is not a read receipt)` | 0 |
| `delivered` | `wake: delivered → <target> (receiver confirmed)` | 0 |
| `held` | `wake: HELD, not delivered yet → <target>: …dropped if nobody approves within 5 minutes…` | 2 |
| `refused` / `dropped` / `denied` / `expired` | `wake: NOT delivered → <target>: <status> (<reason>)…` | 2 |
| the helper gave no result | `wake: outcome unknown → <target>: …` | 3 |
| receipts unavailable | `wake: delivered to inbox → <target>` (the v0.6 wording) | 0 |

Receipts are unavailable on Windows (the reply address would have to be a named pipe and carry auth material ocs must not publish), with `OCS_NO_RECEIPTS=1`, when the reply listener cannot be set up, and when the caller is not the ocs CLI. Exit codes 2 and 3 keep their meaning: the message is stored, do not resend it.

## The delivery notice

When a held message ends up not delivered, the helper sends one notice to **the sender's own session**:

```
[ocs delivery notice] seq <N> to <target> in #<channel> was held for approval and NOT delivered: <status>[ (<reason>)].
The message is still in the channel log; <target> will see it on `ocs inbox` / `ocs read <channel>`. Do not resend.
Fix on the receiving side: `ocs doctor --fix` (sets "crossSessionInbound": "accept" in ~/.claude/settings.json). A repo-level setting can still force hold.
```

- The sender is the host session that ran `ocs` (Claude, Codex or Pi). From a plain shell there is nobody to notify, and the `held` line says so.
- The notice frame carries **no `from`**, so it produces no receipt of its own and cannot loop (held, notice, held again).
- No notice when the sender is the target session.
- A failure in the first phase (`refused` and so on) was already reported by the CLI, so no notice follows.

## On disk

Receipts are written to the same channel log as separate sidecar lines. They are not fields of the message, so older binaries skip them and read the message as before:

```
{"v":1,"type":"receipt","seq":<message seq>,"to":"<target>","status":"<status>","ts":"…"[,"detail":"…"]}
```

A message can have several receipt lines (`held`, then `expired`); readers take the last one per (seq, to). `ocs read` shows `[wake → <target>: <status>]` under **your own** messages, and `--json` has a `delivery` array. Receipt lines do not take part in deriving sequence numbers.

## Across the LAN

A remote DM is woken by the daemon on the receiving machine through the same path. The first-phase result comes back to the sender in the response (`held` and the refusals count as a failed wake, exit 2, with the status in the output). The terminal status is recorded only in the receiving machine's channel log: it is not sent back across machines and no notice is sent. See [lan.md](./lan.md).

## Not covered yet

- Windows has no receipts.
- `held` → `delivered` was verified on real sessions through the policy-release path (the receiver's setting changed from `hold` to `accept` while the message was held: Claude Code released it and sent `delivered`). The interactive approval dialog, which only appears when a message is held for a permission-mode mismatch, is covered by tests against a fake inbox only.
- A `held` receipt that arrives after the 400 ms window is missed, because the helper has already exited as `accepted`.
