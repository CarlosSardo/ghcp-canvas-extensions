# GHCP Canvas Extensions

A personal collection of GitHub Copilot (GHCP) Canvas extensions — live side-panel UIs for the Copilot app & CLI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![Squad Dashboard in demo mode](docs/screenshots/squad-dashboard.png)

## What is a Canvas extension?

A Canvas extension is a regular Copilot CLI extension: an `extension.mjs` file that Copilot starts as a separate Node process and that declares canvases with `joinSession({ canvases: [createCanvas(...)] })`. When a canvas is opened, the extension serves its UI from a loopback URL (`http://127.0.0.1:<port>/`) and the Copilot app shows it in a side panel. `@github/copilot-sdk` is provided by the Copilot runtime, so there is no `package.json` and nothing to `npm install`.

## Catalog

| Extension | Description | Folder |
| --- | --- | --- |
| **Squad Dashboard** | Live roster, status, activity and token/AIU usage for a [Squad](https://github.com/bradygaster/squad) AI agent team. | [`extensions/squad-dashboard`](extensions/squad-dashboard/) |

## Install / load

Copilot discovers extensions in the immediate subfolders of these directories. Each subfolder must contain an `extension.mjs`.

| Scope | Folder |
| --- | --- |
| User (all projects) | `~/.copilot/extensions/<name>/` (`$COPILOT_HOME/extensions/<name>/` if you set `COPILOT_HOME`) |
| Project (committed with a repo) | `<repo>/.github/extensions/<name>/`. A project extension replaces a user extension with the same name. |

### 1. Direct from URL (user scope)

macOS / Linux, using `curl` and `tar` (no git needed):

```sh
mkdir -p ~/.copilot/extensions && curl -fsSL https://codeload.github.com/CarlosSardo/ghcp-canvas-extensions/tar.gz/main | tar -xz -C ~/.copilot/extensions --strip-components=2 ghcp-canvas-extensions-main/extensions/squad-dashboard
```

Any OS with Node.js, using [degit](https://github.com/Rich-Harris/degit):

```sh
npx degit CarlosSardo/ghcp-canvas-extensions/extensions/squad-dashboard ~/.copilot/extensions/squad-dashboard
```

Windows (PowerShell):

```powershell
$ext = "$HOME/.copilot/extensions"; $tmp = Join-Path $env:TEMP 'ghcp-canvas-extensions'
Invoke-WebRequest https://codeload.github.com/CarlosSardo/ghcp-canvas-extensions/zip/refs/heads/main -OutFile "$tmp.zip" -UseBasicParsing
Expand-Archive "$tmp.zip" -DestinationPath $tmp -Force
New-Item -ItemType Directory -Force -Path $ext | Out-Null
Copy-Item "$tmp/ghcp-canvas-extensions-main/extensions/squad-dashboard" -Destination $ext -Recurse -Force
Remove-Item "$tmp.zip", $tmp -Recurse -Force
```

To update, run the `curl` or PowerShell command again, or add `--force` to `degit`, which refuses to write into a folder that is not empty. Updates overwrite files but do not delete files that were removed upstream.

### 2. Project scope

Run the same command from the repository root, targeting `.github/extensions`, then commit the folder:

```sh
mkdir -p .github/extensions && curl -fsSL https://codeload.github.com/CarlosSardo/ghcp-canvas-extensions/tar.gz/main | tar -xz -C .github/extensions --strip-components=2 ghcp-canvas-extensions-main/extensions/squad-dashboard
```

Copying `extensions/<name>/` from a clone of this repository into `.github/extensions/` works as well.

### 3. From a GitHub URL or gist in the Copilot app

- **Ask Copilot**, for example: *"Install the extension from https://github.com/CarlosSardo/ghcp-canvas-extensions/tree/main/extensions/squad-dashboard"*. The app's `install_extension` tool accepts a gist URL, a bare gist ID, or a GitHub folder URL in the `/tree/<ref>/<path>` form. It installs to user scope by default (project or session scope on request) and then reloads extensions.
- **Command palette → "Install extension from gist…"**, then paste a gist URL.
- **To create a gist:** install the extension, then run **"Share extension as gist…"** from the command palette, or ask Copilot to share it. The app uploads the folder to a private gist with a flat file list: subfolders are encoded with `\` in file names, and the gist includes a `copilot-extension.json` manifest (`{ "name": "<name>", "version": 1 }`). Only UTF-8 text files are accepted, up to about 1 MB per file and 5 MB in total.

### 4. Load and open

1. Load the extension. If you installed it with `install_extension`, this happens automatically. Otherwise, ask Copilot to *"reload extensions"* or start a new session. In the CLI, `/clear` also reloads extensions.
2. Open the canvas by asking Copilot, for example: *"Open the Squad Dashboard canvas"*. The canvas ID is `squad-dashboard`.

## Requirements

- A Copilot host that renders canvases, such as the GitHub Copilot app.
- No dependencies to install. Node.js is only needed for `npx degit` and to run the tests (tested with Node.js 22).

## Security

Extensions run locally as Node processes with your user permissions, so review the code before you install one. Copilot withholds sensitive environment variables such as `GITHUB_TOKEN` from extensions unless you approve a request for them. Squad Dashboard requests none. Its HTTP server binds to `127.0.0.1` only, on a random port. It rejects requests whose `Host` header is not a loopback address for that port, and it refuses API, event-stream and `POST` requests from other origins.

## Contributing & license

New extensions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
