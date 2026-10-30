// The OTLP protobuf subset needed for traces and logs. Unknown fields are skipped.
const S = "string", B = "bytes", N = "number", T = "time";
const any = { 1: ["stringValue", S], 2: ["boolValue", N], 3: ["intValue", T],
  4: ["doubleValue", N], 5: ["arrayValue", { 1: ["values", null, true] }],
  6: ["kvlistValue", { 1: ["values", null, true] }], 7: ["bytesValue", B] };
const kv = { 1: ["key", S], 2: ["value", any] };
any[5][1][1][1] = any;
any[6][1][1][1] = kv;
const resource = { 1: ["attributes", kv, true] };
const event = { 1: ["timeUnixNano", T], 2: ["name", S], 3: ["attributes", kv, true] };
const link = { 1: ["traceId", B], 2: ["spanId", B], 4: ["attributes", kv, true] };
const span = { 1: ["traceId", B], 2: ["spanId", B], 3: ["traceState", S],
  4: ["parentSpanId", B], 5: ["name", S], 6: ["kind", N], 7: ["startTimeUnixNano", T],
  8: ["endTimeUnixNano", T], 9: ["attributes", kv, true], 11: ["events", event, true],
  13: ["links", link, true], 15: ["status", { 2: ["message", S], 3: ["code", N] }] };
const log = { 1: ["timeUnixNano", T], 2: ["severityNumber", N], 3: ["severityText", S],
  5: ["body", any], 6: ["attributes", kv, true], 9: ["traceId", B], 10: ["spanId", B] };
const schema = (signal) => ({ 1: [signal === "traces" ? "resourceSpans" : "resourceLogs", {
  1: ["resource", resource], 2: [signal === "traces" ? "scopeSpans" : "scopeLogs", {
    2: [signal === "traces" ? "spans" : "logRecords", signal === "traces" ? span : log, true],
  }, true],
}, true] });

function decode(buf, fields, depth = 0) {
  if (depth > 32) throw new Error("OTLP nesting exceeds 32 levels");
  let pos = 0;
  const out = {};
  function varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (pos >= buf.length) throw new Error("Truncated OTLP varint");
      const byte = buf[pos++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid OTLP varint");
  }
  while (pos < buf.length) {
    const tag = Number(varint()), wire = tag & 7, field = fields[tag >>> 3];
    if (!(tag >>> 3)) throw new Error("Invalid OTLP field");
    let raw;
    if (wire === 0) raw = varint();
    else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(length) || length < 0 || pos + length > buf.length)
        throw new Error("Truncated OTLP field");
      raw = buf.subarray(pos, pos += length);
    } else throw new Error("Unsupported OTLP wire type");
    if (!field) continue;
    const [name, type, repeated] = field;
    let value;
    if (typeof type === "object") {
      if (wire !== 2) throw new Error("Expected OTLP message");
      value = decode(raw, type, depth + 1);
    } else if (type === S || type === B) {
      if (wire !== 2) throw new Error("Expected OTLP bytes");
      value = raw.toString(type === B ? "hex" : "utf8");
    } else if (type === T) {
      value = BigInt.asIntN(64, typeof raw === "bigint" ? raw : raw.readBigUInt64LE()).toString();
    } else {
      value = typeof raw === "bigint" ? Number(raw) : wire === 1 ? raw.readDoubleLE() : raw.readFloatLE();
      if (name === "boolValue") value = Boolean(value);
    }
    if (repeated) (out[name] ??= []).push(value);
    else out[name] = value;
  }
  return out;
}

export function decodeOTLP(buffer, signal, contentType) {
  if (contentType?.includes("application/json")) {
    try { return JSON.parse(buffer.toString("utf8")); }
    catch (error) { throw new Error("Invalid OTLP JSON", { cause: error }); }
  }
  if (!contentType?.includes("application/x-protobuf")) throw new Error("Use application/x-protobuf or application/json");
  return decode(buffer, schema(signal));
}

export function anyValue(value = {}) {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return String(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(anyValue);
  if (value.kvlistValue) return attributes(value.kvlistValue.values);
  if ("bytesValue" in value) return "[binary omitted]";
  return "";
}

export function attributes(list = []) {
  return Object.fromEntries(list.map(({ key, value }) => [key, anyValue(value)]));
}

export function records(payload, signal) {
  const resources = payload[signal === "traces" ? "resourceSpans" : "resourceLogs"];
  if (!Array.isArray(resources)) throw new Error(`Missing resource${signal === "traces" ? "Spans" : "Logs"}`);
  const out = [];
  for (const r of resources) {
    const resourceAttrs = attributes(r.resource?.attributes);
    const scopes = r[signal === "traces" ? "scopeSpans" : "scopeLogs"] ?? [];
    if (!Array.isArray(scopes)) throw new Error("Invalid OTLP scopes");
    for (const scope of scopes) {
      const items = scope[signal === "traces" ? "spans" : "logRecords"] ?? [];
      if (!Array.isArray(items)) throw new Error("Invalid OTLP records");
      for (const item of items) {
        if (!item || typeof item !== "object") throw new Error("Invalid OTLP record");
        out.push({ ...item, attributes: { ...resourceAttrs, ...attributes(item.attributes) } });
      }
    }
  }
  return out;
}
