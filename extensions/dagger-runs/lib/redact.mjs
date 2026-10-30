const sensitive = /token|secret|password|key|authorization|cookie|credential/i;

export function redactor(env = process.env) {
  let values = Object.entries(env).filter(([k, v]) => sensitive.test(k) && v)
    .map(([, v]) => v).sort((a, b) => b.length - a.length);
  const text = (value) => {
    let result = String(value ?? "");
    for (const secret of values) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/(\b[\w.-]{0,256}(?:token|secret|password|key)[\w.-]{0,256}\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*')/gi, "$1[REDACTED]")
      .replace(/(\b[\w.-]{0,256}(?:token|secret|password|key)[\w.-]{0,256}\s*["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, "$1[REDACTED]")
      .replace(/(--[\w-]*(?:token|secret|password|key)[\w-]*\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
      .replace(/\b(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+\S+)/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[REDACTED]@");
  };
  function capture(value, key = "") {
    if (sensitive.test(key) && typeof value === "string" && value && value !== "[REDACTED]") {
      if (!values.includes(value)) values.push(value);
      values.sort((a, b) => b.length - a.length);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) capture(v, k);
    }
  }
  function clean(value, key = "") {
    if (sensitive.test(key)) return "[REDACTED]";
    if (key === "dagger.io/dag.call" || key === "dagger.io/log.media.data") return "[payload omitted]";
    if (key.startsWith("dagger.io/git.") || key === "dagger.io/client.machine_id") return "[metadata omitted]";
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((v) => clean(v));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    return value;
  }
  return { text, clean, capture };
}
