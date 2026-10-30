import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**", "examples/module/**", "test/fixtures/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: Object.fromEntries(["process", "Buffer", "URL", "fetch", "setTimeout", "clearTimeout",
        "setInterval", "clearInterval", "setImmediate", "queueMicrotask", "document", "EventSource", "requestAnimationFrame", "getComputedStyle"].map((k) => [k, "readonly"])),
    },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] },
  },
  { files: ["lib/manager.mjs", "ui/app.js"], rules: { "no-control-regex": "off" } },
];
