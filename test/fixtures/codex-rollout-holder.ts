import { openSync } from "node:fs";

openSync(process.argv[2]!, "r");
console.log(JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
