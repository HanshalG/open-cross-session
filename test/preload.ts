// 测试里起的 CLI 子进程都从 process.env 派生环境：在这里统一关掉每日版本检查，
// 否则每个 CLI 调用都可能派出一个后台进程去查 GitHub（或测试自己的假服务器）。
// 检查本身由 test/upgrade.test.ts 显式打开后单独测。
process.env.OCS_NO_UPDATE_CHECK = "1";
