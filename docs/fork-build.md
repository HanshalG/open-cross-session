# Build this fork

This fork uses Codex Desktop's local index to display sidebar titles, exclude
internal review sessions, and assign persistent, distinct OCS names. It retains
the existing delivery and LAN pairing protocols.

Install Git and Bun, then clone and check the source:

```sh
git clone https://github.com/HanshalG/open-cross-session.git
cd open-cross-session
bun install
bun test
bunx tsc --noEmit
bun build --compile src/cli.ts --outfile ./dist/ocs
```

On macOS, sign the compiled binary locally and verify it before installation:

```sh
codesign --force --sign - ./dist/ocs
codesign --verify --deep --strict --verbose=2 ./dist/ocs
./dist/ocs help
mkdir -p "$HOME/.local/bin"
install -m 755 ./dist/ocs "$HOME/.local/bin/ocs"
"$HOME/.local/bin/ocs" skill install
```

This is an ad-hoc signature for a local build, not Developer ID signing or
notarization. On Linux, skip the two `codesign` commands.

If the LAN daemon was running, restart it to load the new binary:

```sh
"$HOME/.local/bin/ocs" lan down
"$HOME/.local/bin/ocs" lan up
"$HOME/.local/bin/ocs" who --lan
```

Reuse any custom address, port, discovery, or name options from your previous
`lan up` command. Pairing data stays under `~/.ocs`; do not delete it to upgrade.
Names are assigned during roster discovery and keep resolving to the full
thread UUID even when short IDs collide. Existing user-assigned names stay in
place; use `ocs rename <name>` inside a chat to choose a different name.

This fork's `ocs upgrade` and release installers fetch releases from
`HanshalG/open-cross-session`. To update a source checkout, pull its source and
repeat the build and installation steps.
