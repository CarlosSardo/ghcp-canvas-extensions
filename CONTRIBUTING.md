# Contributing

Thanks for adding to the collection! Each extension is self-contained and has no dependencies.

## Folder conventions

```text
extensions/<name>/
├── extension.mjs            # entry point (required, exact name)
├── copilot-extension.json   # { "name": "<name>", "version": 1 } (name = folder name)
├── README.md                # what it does, configuration, how to test
├── lib/ ui/ ...             # optional modules and assets
└── test/*.test.mjs          # optional tests (recommended)
```

- Put screenshots in `docs/screenshots/<name>.png` at the repository root, not in the extension folder. Gist sharing only accepts UTF-8 text files.
- Keep each file under about 1 MB and the folder under about 5 MB, which are the gist limits.

## Rules

- **ESM only.** Name the entry file `extension.mjs` and use `import`/`export`. Copilot provides `@github/copilot-sdk`, so do not add a `package.json` for it.
- **Never write to stdout.** No `console.log`: stdout is the JSON-RPC channel to Copilot. Use `session.log()` or a log file.
- **Loopback only.** Bind servers to `127.0.0.1` on port `0`, and validate `Host`/`Origin` on anything that reads or changes state.
- **No secrets.** Do not include tokens, credentials, personal paths, emails or session data in code, fixtures, demo data or screenshots.
- **Zero dependencies.** If you really need a library, vendor it into the extension folder. Do not commit `node_modules/`.

## Develop and test

1. Copy or symlink your folder into `~/.copilot/extensions/<name>/` or `<repo>/.github/extensions/<name>/`.
2. Ask Copilot to *"reload extensions"*, then open your canvas. If it does not show up, `extensions_manage` (`list` / `inspect`) shows whether it failed and prints the tail of its log.
3. Run the tests from the extension folder:

   ```sh
   cd extensions/<name>
   node --test
   ```

   Tests must clean up after themselves and leave `git status` clean.

## Add it to the catalog

Add one row to the **Catalog** table in the root [README.md](README.md): the name, a one-line description, and a link to the folder.

## Pull request checklist

- [ ] `extensions/<name>/` contains `extension.mjs`, `copilot-extension.json` and `README.md`.
- [ ] The extension loads without errors and its canvas opens in the Copilot app.
- [ ] `node --test` passes, and no scratch files are left behind.
- [ ] Nothing is written to stdout, and servers bind to `127.0.0.1` only.
- [ ] No secrets, tokens, personal paths or emails (grep before you commit).
- [ ] The folder contains only text files and stays within the gist limits.
- [ ] A catalog row is added to `README.md`.
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(<name>): add …`, `fix(<name>): …`, `docs: …`.
