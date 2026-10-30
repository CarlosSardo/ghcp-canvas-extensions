import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

export async function listen(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) { res.writeHead(error.status ?? 400, { "Content-Type": "application/json" }); }
      res.end(JSON.stringify({ error: error.publicMessage ?? "Invalid request" }));
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(error.code === "EADDRINUSE" ?
      "No free loopback port is available. Close an unused local service and retry." :
      `Could not open a loopback server: ${error.code ?? "network error"}`, { cause: error })));
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: async () => {
    server.closeIdleConnections();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}

export function guard(req, origin, staticAsset = false) {
  if (req.headers.host !== new URL(origin).host ||
      (!staticAsset && ((req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"))) {
    throw Object.assign(new Error("Forbidden origin"), { status: 403 });
  }
}

export async function body(req, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Body exceeds limit"), { status: 413 });
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (req.headers["content-encoding"] === "gzip")
    return gunzipSync(buffer, { maxOutputLength: limit });
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    throw new Error("Unsupported Content-Encoding");
  return buffer;
}

export function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
