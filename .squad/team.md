# Squad Team

> ghcp-canvas-extensions

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Lead | Lead / Architect | .squad/agents/lead/charter.md | 🏗️ Lead |
| Frontend | Frontend Dev | .squad/agents/frontend/charter.md | ⚛️ Frontend |
| Backend | Backend Dev | .squad/agents/backend/charter.md | 🔧 Backend |
| Tester | Tester | .squad/agents/tester/charter.md | 🧪 Tester |
| Security | Security Engineer | .squad/agents/security/charter.md | 🔒 Security |
| Scribe | Session Logger | .squad/agents/scribe/charter.md | 📋 Scribe |
| Ralph | Work Monitor | .squad/agents/ralph/charter.md | 🔄 Monitor |
| Rai | RAI Reviewer | .squad/agents/Rai/charter.md | 🛡️ RAI |
| Fact Checker | Fact Checker | .squad/agents/fact-checker/charter.md | 🔍 Verifier |
| Carlos Sardo | Dev Lead | — | 👤 Human |


## Coding Agent

<!-- copilot-auto-assign: false -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- Bug fixes with clear reproduction steps
- Test coverage (adding missing tests, fixing flaky tests)
- Lint/format fixes and code style cleanup
- Dependency updates and version bumps
- Small isolated features with clear specs
- Boilerplate/scaffolding generation
- Documentation fixes and README updates

**🟡 Needs review — route to @copilot but flag for squad member PR review:**
- Medium features with clear specs and acceptance criteria
- Refactoring with existing test coverage
- API endpoint additions following established patterns
- Migration scripts with well-defined schemas

**🔴 Not suitable — route to squad member instead:**
- Architecture decisions and system design
- Multi-system integration requiring coordination
- Ambiguous requirements needing clarification
- Security-critical changes (auth, encryption, access control)
- Performance-critical paths requiring benchmarking
- Changes requiring cross-team discussion

## Project Context

- **Owner:** Carlos Sardo
- **Project:** ghcp-canvas-extensions — a collection of GitHub Copilot Canvas extensions (live side-panel UIs for the Copilot app & CLI)
- **Stack:** Zero-dependency Node.js ESM, `@github/copilot-sdk` (runtime-provided), loopback HTTP + SSE, vanilla HTML/CSS/JS, `node:test`
- **Universe:** descriptive
- **Created:** 2026-09-30
