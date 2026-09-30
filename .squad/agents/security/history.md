# Project Context

- **Owner:** Carlos Sardo
- **Project:** ghcp-canvas-extensions — a collection of GitHub Copilot Canvas extensions (live side-panel UIs for the Copilot app & CLI). First extension: Squad Dashboard (`extensions/squad-dashboard`).
- **Stack:** Zero-dependency Node.js ESM (`extension.mjs` + `lib/*.mjs`), `@github/copilot-sdk` (provided by the Copilot runtime — no package.json/npm install), loopback HTTP + SSE server, vanilla HTML/CSS/JS UI, `node:test` for tests.
- **Created:** 2026-09-30T12:35:56+02:00

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->

- 2026-09-30: Team directive — all commits and PR titles use Conventional Commits (`type(scope): description`; scope = extension folder where applicable). See decisions.md.
