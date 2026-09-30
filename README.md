# GHCP Canvas Extensions

A few GitHub Copilot Canvas extensions for the Copilot app and CLI.

This repo is powered by [Squad](https://bradygaster.github.io/squad/): a team of AI agents that lives in the repo helps build and maintain it.

## What's a Canvas extension?

A Canvas extension is an `extension.mjs` file Copilot starts as a separate Node process. It serves a small UI on `127.0.0.1`, and Copilot shows that UI in a side panel. `@github/copilot-sdk` comes from the Copilot runtime, so there is no `package.json` and nothing to `npm install`.

## Catalog

| Extension | Description | Folder |
| --- | --- | --- |
| **Squad Dashboard** | Live roster, status, activity and token/AIU usage for a [Squad](https://github.com/bradygaster/squad) AI agent team. | [`extensions/squad-dashboard`](extensions/squad-dashboard/) |

## Install

Fastest path: ask Copilot in the app:
> Install the extension from https://github.com/CarlosSardo/ghcp-canvas-extensions/tree/main/extensions/squad-dashboard

macOS / Linux, using `curl` and `tar`:

```sh
mkdir -p ~/.copilot/extensions && curl -fsSL https://codeload.github.com/CarlosSardo/ghcp-canvas-extensions/tar.gz/main | tar -xz -C ~/.copilot/extensions --strip-components=2 ghcp-canvas-extensions-main/extensions/squad-dashboard
```

Any OS with Node.js, using [degit](https://github.com/Rich-Harris/degit):

```sh
npx degit CarlosSardo/ghcp-canvas-extensions/extensions/squad-dashboard ~/.copilot/extensions/squad-dashboard
```

<details>
<summary>Windows (PowerShell)</summary>

```powershell
$ext = "$HOME/.copilot/extensions"; $tmp = Join-Path $env:TEMP 'ghcp-canvas-extensions'
Invoke-WebRequest https://codeload.github.com/CarlosSardo/ghcp-canvas-extensions/zip/refs/heads/main -OutFile "$tmp.zip" -UseBasicParsing
Expand-Archive "$tmp.zip" -DestinationPath $tmp -Force
New-Item -ItemType Directory -Force -Path $ext | Out-Null
Copy-Item "$tmp/ghcp-canvas-extensions-main/extensions/squad-dashboard" -Destination $ext -Recurse -Force
Remove-Item "$tmp.zip", $tmp -Recurse -Force
```

</details>

For project scope, use `.github/extensions` instead of `~/.copilot/extensions`, then commit the folder.

To update, re-run the command. With `degit`, add `--force`.

For gists, use the command palette: **Install extension from gist…** or **Share extension as gist…**.

## Open it

If you installed it by asking Copilot, extensions reload automatically. Otherwise, reload extensions by asking Copilot to "reload extensions", starting a new session, or using `/clear` in the CLI.

Then ask Copilot:
> Open the Squad Dashboard canvas

## Requirements

- A Copilot host that renders canvases, like the GitHub Copilot app.
- No dependencies.
- Node.js only if you use `degit` or run the tests.

## Security

Extensions run locally as you, so skim the code before installing one. Squad Dashboard asks for no tokens, listens only on `127.0.0.1`, turns away requests with a non-loopback `Host` header, and won't answer API or event-stream requests from other origins.

## Contributing & license

New extensions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). It's [MIT licensed](LICENSE).

## Disclaimer

These extensions are provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability arising from, out of or in connection with the software or its use. Use these extensions at your own risk. The MIT License in [LICENSE](LICENSE) governs this software; this notice does not modify its terms.
