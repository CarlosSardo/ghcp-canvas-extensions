import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createExtension } from "./lib/extension-core.mjs";

await createExtension({ CanvasError, createCanvas, joinSession });
