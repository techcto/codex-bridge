# Codex Bridge VS Code Extension

This is a lightweight VS Code extension for talking to `codex-bridge`.

## What It Does

- saves bridge connection settings in VS Code
- treats a direct local sidecar as the primary dev workflow
- can start and stop a local `codex-bridge` sidecar from VS Code
- pushes runtime config to `POST /runtime/config`
- checks `GET /health`
- opens a simple chat webview backed by:
  - `POST /chat/sessions`
  - `POST /chat/sessions/{id}/messages`
- auto-starts the local bridge on extension startup when localhost is configured
- reuses an already healthy local bridge on the configured port instead of spawning a duplicate
- surfaces clearer port, health, and runtime-config diagnostics when the bridge is unavailable or unhealthy
- adds a status bar shortcut for opening chat quickly
- adds a Codex Bridge activity-bar entry and sidebar
- resolves native Codex from `codexBridge.localCodexPath`, bundled runtime, or `codex` on `PATH`
- passes the active workspace root to the bridge so native Codex can edit files in place
- forwards image attachments from the chat panel to the bridge/native Codex path

## Commands

- `Codex Bridge: Configure Connection`
- `Codex Bridge: Start Local Bridge`
- `Codex Bridge: Stop Local Bridge`
- `Codex Bridge: Restart Local Bridge`
- `Codex Bridge: Show Bridge Logs`
- `Codex Bridge: Check Health`
- `Codex Bridge: Open Chat`

The `Open Chat` command is also contributed to the editor title toolbar when a file is open.

## Local Development

```bash
cd codex-bridge/vscode-extension
npm install
npm run build
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Bundled Runtime Prep

The extension can prefer a bundled local Codex runtime before falling back to `codex` on `PATH`.

Expected per-platform layout:

- `bundled-runtime/win32-x64/codex.exe`
- `bundled-runtime/linux-x64/codex`
- `bundled-runtime/darwin-arm64/codex`

Helper flow:

```bash
npm run prepare:bundled-runtime -- --source /absolute/path/to/codex.exe --platform win32-x64
npm run build
```

From the `codex-bridge` repo root you can also use:

```bash
./cmd.sh codexruntimebuildwin
./cmd.sh codexruntimebuildlinux
./cmd.sh codexbridgebundlewin /absolute/path/to/codex.exe
./cmd.sh codexbridgebundlelinux /absolute/path/to/codex
./cmd.sh codexbridgebundlemanifest
./cmd.sh codexbridgevscodebuild
./cmd.sh codexbridgevscodepackage
```

To build from source, clone the Codex repo next to `codex-bridge`:

```bash
cd ..
git clone https://github.com/techcto/codex.git
```

By default, the helper commands look for Codex source at:

```text
../codex/codex-rs
```

From inside `vscode-extension`, that root is one directory up:

```bash
cd ..
./cmd.sh codexruntimebuildwin
./cmd.sh codexruntimebuildlinux
./cmd.sh codexbridgebundlewin /absolute/path/to/codex.exe
./cmd.sh codexbridgebundlelinux /absolute/path/to/codex
./cmd.sh codexbridgebundlemanifest
./cmd.sh codexbridgevscodebuild
./cmd.sh codexbridgevscodepackage
```

For easier local testing, you can also drop a Windows runtime here without committing it:

```text
tools/codex-runtime/win32-x64/codex.exe
```

That path is gitignored, and `./cmd.sh codexbridgevscodebuild` / `./cmd.sh codexbridgevscodepackage` will automatically bundle it if present.

If you have the Codex source checked out next to `codex-bridge` as `../codex/codex-rs` and a working Rust toolchain, you can build the staged runtime directly from source:

```bash
./cmd.sh codexruntimebuildwin
./cmd.sh codexbridgevscodebuild
```

If your Codex source lives somewhere else, set `CODEX_SOURCE_DIR`:

```bash
CODEX_SOURCE_DIR=/absolute/path/to/codex/codex-rs ./cmd.sh codexruntimebuildwin
```

Typical source-build flow for local extension testing:

```bash
cd ..
./cmd.sh codexruntimebuildwin
./cmd.sh codexbridgevscodebuild
```

That stages the runtime to:

```text
tools/codex-runtime/win32-x64/codex.exe
```

and the extension build will bundle it automatically if present.

You can also set `codexBridge.localCodexPath` to an absolute executable path for testing a custom local build before bundling it.

## Local Sidecar Flow

If `codexBridge.baseUrl` points at `http://127.0.0.1:4400` or `http://localhost:4400`, the extension treats the local sidecar as the primary dev path and can manage the bridge for you.

Recommended flow:

1. Run `Codex Bridge: Configure Connection`
2. Leave the base URL on localhost
3. Run `Codex Bridge: Start Local Bridge`
4. Run `Codex Bridge: Check Health`
5. Run `Codex Bridge: Open Chat`

When `codexBridge.autoStartLocalBridge` is enabled, the extension will also try to start the bridge automatically before health checks or chat opens. If a healthy bridge is already running on the configured port, the extension connects to it instead of starting a second process.

With the default settings, the extension also initializes on VS Code startup and shows a `Codex Bridge` status bar button for one-click access.

## How VS Code Talks To Native Codex

The current execution path is:

```text
VS Code chat panel
  -> extension services/controllers
  -> local codex-bridge sidecar
  -> native Codex CLI or Codex App Server
  -> streamed events back to the extension
```

Runtime resolution order:

1. `codexBridge.localCodexPath`
2. bundled runtime in `vscode-extension/bundled-runtime/<platform>/`
3. `codex` on `PATH`

The extension sends:

- runtime provider/auth config
- workspace root
- active editor context
- thread/session context
- image attachments from the chat panel

The bridge then launches native Codex with `workspace-write`, so file edits land in your real VS Code workspace.

Recommended provider order:

1. `openai`
2. `osirus`
3. `osirus_agent`
4. `ollama`
5. `vllm`
6. `openai_compatible`

Recommended local split:

1. CMS Docker bridge: `http://127.0.0.1:4399`
2. VS Code extension sidecar: `http://127.0.0.1:4400`

## Notes

- The chat panel is intentionally minimal so we can iterate on the protocol first.
- Runtime config is sourced from VS Code settings under `codexBridge.*`.
- Provider API keys are stored in VS Code secret storage and migrated out of legacy plain-text `settings.json` entries when possible.
- For full local Codex runtime behavior, you need either:
  - a globally installed `codex`, or
  - a bundled runtime built from source, or
  - `codexBridge.localCodexPath` pointing to a local executable
- OpenAI is the default first-run path for Codex Bridge.
- Osirus is the next featured path and supports both `osirus` and `osirus_agent`.
- `osirus_agent` uses the agent-scoped `/v1` endpoint.
- Docker is optional for local development. The normal extension workflow is direct sidecar startup via `server.mjs`.
- In local sidecar mode, the extension prefers `codexBridge.localCodexPath`, then a bundled Codex runtime, then `codex` on `PATH`.
- The current attachment path is image-first. Image attachments are forwarded to native Codex; richer non-image attachment ingestion is still a future improvement.

## Local VSIX Test

From the `codex-bridge` repo root:

```bash
./cmd.sh codexbridgevscodepackage
```

That creates a `.vsix` in the extension folder. You can then install it locally with:

```bash
code --install-extension vscode-extension/codex-bridge-vscode-0.0.1.vsix
```
