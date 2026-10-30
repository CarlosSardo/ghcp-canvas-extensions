import { RunManager } from "./lib/manager.mjs";
import { createPanel } from "./lib/extension-core.mjs";

const manager = new RunManager({ report: (message) => process.stderr.write(`${message}\n`) });
await manager.init();
const panel = await createPanel(manager, { cwd: process.cwd(), command: "dagger api query --doc extensions/dagger-runs/examples/pipeline.graphql Fail" });
process.stdout.write(`${panel.url}\n`);
const shutdown = async () => { await panel.close(); await manager.close(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
