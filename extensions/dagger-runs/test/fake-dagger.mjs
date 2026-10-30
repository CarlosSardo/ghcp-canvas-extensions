#!/usr/bin/env node
import { spawn } from "node:child_process";

if (process.argv[2] === "version") {
  process.stdout.write("dagger v0.21.11\n");
} else if (process.argv[2] === "tree") {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("descendant-ready\\n");setInterval(()=>{},1000)'], { stdio: "inherit" });
  process.stdout.write(`descendant=${child.pid}\n`);
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "crash") {
  process.stderr.write("Engine unavailable: start Docker\n");
  process.exitCode = 2;
} else {
  process.stdout.write("password='with spaces'\n");
  process.stdout.write("split-");
  setTimeout(() => { process.stdout.write("secret-value\n"); process.stderr.write("no-newline"); }, 20);
}
