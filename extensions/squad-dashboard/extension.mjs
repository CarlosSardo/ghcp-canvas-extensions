import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createSquadDashboardExtension } from "./lib/extension-core.mjs";

await createSquadDashboardExtension({
  CanvasError,
  createCanvas,
  joinSession,
  extensionRoot: path.dirname(fileURLToPath(import.meta.url)),
});
