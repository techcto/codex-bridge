# Codex Bridge

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Docker Compose](https://img.shields.io/badge/docker-compose-available-brightgreen.svg)](docker-compose.yml)
[![Runtime](https://img.shields.io/badge/runtime-app__server__adapter-6c5ce7.svg)](#environment)

This repo provides an open-source Codex runtime bridge that host apps can embed. It exposes a small REST + SSE surface that applications can call for chat sessions, auth, runtime info, and streaming events. OpenAI is the primary default path, Osirus is the next featured provider, and other OpenAI-compatible backends remain supported.

Supported runtime providers, in recommended order:

- `openai`
- `osirus`
- `osirus_agent`
- `ollama`
- `vllm`
- `openai_compatible`

## Why This Exists

Many applications need Codex to fit into their own auth, UI, and workflow model. This bridge keeps the integration light: the host app owns permissions and UX, while the runtime focuses on execution and streaming.

## Grant Pitch

The Codex Bridge enables open, interoperable AI editing for CMS platforms without vendor lock-in. It reduces integration time from weeks to hours, supports local or cloud models via OpenAI-compatible routes, and keeps platform-specific permissions and content workflows in the CMS where they belong. Funding will help us harden the runtime, improve performance, and deliver plug-and-play adapters for popular CMS stacks.

## What’s Inside

- `server.mjs`: bridge bootstrap and service wiring
- `app-server-client.mjs`: client utilities for the app-server adapter runtime
- `server-lib/auth-service.mjs`: device auth and login state
- `server-lib/chat-session-service.mjs`: session queueing, streaming, turn execution, CMS generation helpers
- `server-lib/request-handler.mjs`: HTTP route dispatch
- `vscode-extension/`: VS Code extension, bundled-runtime helpers, and packaging flow
- `cmd.sh`: bridge-local helper commands for runtime builds, extension packaging, and Docker workflows

## How It Works

```text
Host App UI
   |
   v
VS Code extension or other host integration
   |
   | HTTP + SSE
   v
codex-bridge
   |
   | spawn / app-server
   v
Native Codex CLI or Codex App Server
   |
   v
Workspace reads, file edits, streamed events
```

The current VS Code path is:

1. The extension resolves a Codex executable from `codexBridge.localCodexPath`, bundled runtime, or `codex` on `PATH`.
2. The extension starts `server.mjs` as the local sidecar.
3. The extension sends runtime config, workspace root, and chat context to the bridge.
4. The bridge launches native Codex with `workspace-write` sandboxing.
5. Codex reads and edits files in the workspace, and the bridge streams those events back to the extension.

## Current Capability Status

What is wired and working:

- native Codex can be built from source with `cmd.sh`
- the VS Code extension can bundle that runtime and launch it via `CODEX_BIN`
- the bridge passes the active workspace root to Codex
- chat sessions stream over SSE
- Codex can edit files in the workspace through `workspace-write`
- Codex can run workspace shell commands, including git status/history inspection, within the configured sandbox
- image attachments from the VS Code chat panel are sent through the bridge to native Codex
- provider/runtime config can be changed without changing the bridge code

What is still partial or missing:

- the chat webview is still custom/minimal, not a full React-style app shell
- there is no diff/approval UI yet before workspace edits
- non-image file attachments are not yet materialized into a richer native Codex file-ingest flow; the current bridge attachment path is image-first
- provider model pickers can influence runtime config, but not every upstream model behaves as well as native Codex for code editing
- the bridge is modular now, but `server-lib/chat-session-service.mjs` is still the biggest remaining class and could be split further

## Agent Runtime Classes

Codex Bridge now treats every backend as a `codex_agent` runtime, not a plain chat integration. The runtime can satisfy that contract in three different ways:

- `native_tools`: the runtime exposes Codex-style workspace tools directly, so file edits, command execution, and git inspection can happen natively
- `model_tools`: the runtime depends on the selected upstream model supporting tool use correctly; this path is model-dependent and should be treated as experimental until verified
- `bridge_tools`: the host app intends to augment the model with a bridge-side tool adapter; this is the right shape for regular chat models, but the edit adapter still needs to be implemented

The key rule is that model text is never the source of truth for workspace actions. A file edit, command run, or git inspection only counts as real when the bridge receives verified tool results from the runtime or from a future bridge-side adapter.

Both `model_tools` and `bridge_tools` ultimately depend on the same local workspace tool protocol. The difference is how tool intent reaches that local executor:

- `model_tools`: the upstream model/runtime emits structured tool-call intent directly, and the local bridge executes those actions against the real VS Code workspace
- `bridge_tools`: the upstream model does not natively produce trustworthy tool calls, so the bridge must translate model intent into the same local workspace tool protocol itself

That means the long-term architecture is still local execution in every case. The only thing that changes between `model_tools` and `bridge_tools` is where the structured tool intent comes from.

The planned local-first tool protocol covers bridge-executed actions such as:

- `list_files`
- `read_file`
- `search_text`
- `run_command`
- `git_status`
- `git_log`
- `git_diff`
- `apply_patch`

### Bridge-Side Tool Adapter Notes

The `bridge_tools` path now includes a local planner/executor loop for models that do not emit native Codex tool calls. This adapter keeps workspace actions grounded in verified tool results instead of trusting model narration.

Important behavior:

- `rg`/ripgrep is optional. The bridge uses it when available for fast file and text search, then falls back to bounded Node filesystem traversal when it is missing from `PATH`.
- The planner receives VS Code active editor and open-tab context. If a model invents placeholder paths such as `file.md` while the user is referring to the visible/current editor, the bridge rewrites the path to the active editor file before execution.
- `insert_in_file` supports precise placement by `line_number`, with `line`, `lineNumber`, `position`, and `anchor_text` aliases. A plain `line_number: 3` inserts before line 3; `position: "after"` inserts after that line.
- If both `line_number` and `anchor_text` are provided, the anchor is matched only on that line. This handles requests such as “insert after `GPUWire is a marketplace` on line 5.”
- Failed mutating tools cannot be followed by a success-sounding final answer unless the failure is acknowledged. This prevents “edit succeeded” messages after a rejected or invalid tool call.
- Stale Osirus chat IDs are cleared from local thread state after remote 404s, so deleted remote chats do not keep getting rehydrated.

## Running Locally

Fastest direct bridge run:

```bash
npm install -g @openai/codex
node server.mjs
```

The bridge listens on port `4399` by default. You can override via `CODEX_BRIDGE_PORT`.

If you do not want to rely on a globally installed `codex`, clone the Codex source and build a local runtime instead. The bridge and VS Code extension can use that local runtime through the helper commands below.

## Bridge-Local Helper Commands

From the `codex-bridge` repo root:

```bash
./cmd.sh codexruntimebuildwin
./cmd.sh codexruntimebuildlinux
./cmd.sh codexbridgevscodebuild
./cmd.sh codexbridgevscodepackage
./cmd.sh codexbridgeup
./cmd.sh codexbridgelogs
```

Notes:

- staged local runtimes live under `tools/codex-runtime/`
- by default `./cmd.sh codexruntimebuild*` looks for Codex source at `../codex/codex-rs`
- if your Codex source lives elsewhere, set `CODEX_SOURCE_DIR=/absolute/path/to/codex/codex-rs`

## Cloning Codex Source

The easiest open-source layout is to check out the Codex source next to `codex-bridge`:

```bash
cd ..
git clone https://github.com/techcto/codex.git
```

That gives you:

```text
.../codex-bridge
.../codex
```

and `./cmd.sh codexruntimebuild*` will automatically look in:

```text
../codex/codex-rs
```

Example:

```bash
CODEX_SOURCE_DIR=/absolute/path/to/codex/codex-rs ./cmd.sh codexruntimebuildwin
```

## Building Local Codex Runtimes

Prerequisites:

- Rust toolchain with `cargo`
- for Windows builds, the MSVC Rust toolchain plus Visual Studio Build Tools with C++

Build commands:

```bash
./cmd.sh codexruntimebuildwin
./cmd.sh codexruntimebuildlinux
./cmd.sh codexruntimebuildmac
```

Those commands stage the built runtime under:

```text
tools/codex-runtime/win32-x64/codex.exe
tools/codex-runtime/linux-x64/codex
tools/codex-runtime/darwin-arm64/codex
```

The VS Code extension build will automatically bundle any staged runtimes it finds under:

```text
tools/codex-runtime/<platform>/codex[.exe]
```

## VS Code Extension

Build and package from the bridge repo root:

```bash
./cmd.sh codexruntimebuildwin
./cmd.sh codexbridgevscodebuild
./cmd.sh codexbridgevscodepackage
```

Or directly from the extension folder:

```bash
cd vscode-extension
npm install
npm run build
```

To test in VS Code:

1. Open `vscode-extension/` in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Use `Codex Bridge: Configure Connection`.
4. Start the local bridge or let the extension auto-start it.

The extension README has the provider-specific details:

- [vscode-extension/README.md](./vscode-extension/README.md)

## Native Codex Runtime Path

The native Codex path is:

```text
cmd.sh codexruntimebuild*
  -> tools/codex-runtime/<platform>/codex[.exe]
  -> bundled into vscode-extension/bundled-runtime/<platform>/
  -> resolved by the extension
  -> passed to the bridge as CODEX_BIN
  -> launched by the bridge for chat turns
```

The bridge reports its active executable and sandbox mode through `GET /runtime/info`.

## CMS Integration

A CMS image or VM can copy this repository into `/opt/codex-bridge` and run:

```bash
node /opt/codex-bridge/server.mjs
```

The CMS talks to the bridge through the Codex service URL (see provider settings in your platform). For CMS environments, the preferred deployment model is a host-managed `codex-bridge` service with separate logs, health checks, and restart policy from the CMS itself.

## Environment

Common variables:

- `CODEX_BRIDGE_PORT` (default `4399`)
- `CODEX_RUNTIME_KIND` (default `app_server_adapter`)
- `CODEX_WORKSPACE_ROOT` (CMS workspace root)
- `CODEX_MAX_CONCURRENT_TURNS` (default `4`)
- `CODEX_MAX_QUEUED_TURNS` (default `40`)

## Docker Compose (Optional Local Testing)

Run the bridge locally with Docker Compose if you want a containerized test path:

```bash
docker compose up --build
```

This starts the bridge on port `4399` and mounts the current repo into the container. You can override environment variables in `docker-compose.yml`.

Docker is optional. The primary local dev path is running `server.mjs` directly, and the preferred CMS runtime path is a host-managed bridge service.

## Public Repo Hygiene

This repository is intended to be safe to publish publicly.

Local-only artifacts are gitignored, including:

- `tools/` staged runtimes
- `vscode-extension/bundled-runtime/*/codex*`
- `vscode-extension/.vscode/`
- `vscode-extension/.claude/`
- `vscode-extension/.codex`
- `*.vsix`
- local `.env*` files

Do not commit:

- API keys or bearer tokens
- local Codex runtime binaries
- VS Code workspace state
- packaged extension output

The examples in this README use placeholders like `YOUR_API_KEY`; replace them locally, not in committed files.

## API Surface (Core)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health + auth state |
| `GET` | `/runtime/info` | Runtime metadata |
| `GET` | `/runtime/config` | Current runtime config |
| `POST` | `/runtime/config` | Update runtime config |
| `ANY` | `/v1/*` | Proxy OpenAI-compatible upstream routes |
| `POST` | `/chat/sessions` | Create a session |
| `GET` | `/chat/sessions/:id` | Read a session |
| `GET` | `/chat/sessions/:id/stream` | SSE stream |
| `POST` | `/chat/sessions/:id/messages` | Send a message |
| `DELETE` | `/chat/sessions` | Clear sessions |
| `GET` | `/auth/device` | Device auth start |
| `GET` | `/auth/status` | Auth status |

## Runtime Info

`GET /runtime/info` reports:

- `runtime_kind`
- `codex_command`
- `sandbox_mode`
- `workspace_root`
- `runtime_config`
- bridge load counters

## Architecture

![Architecture](docs/assets/architecture.svg)

## Demo

![Demo](docs/assets/demo.svg)

## Quick Demo

```bash
curl -s http://localhost:4399/runtime/info | jq .
```

Point the bridge at an Osirus agent-scoped compatibility route:

```bash
curl -s -X POST http://localhost:4399/runtime/config \
  -H "Content-Type: application/json" \
  -d '{
    "runtime_provider": "osirus",
    "auth_mode": "api_key",
    "provider_api_base_url": "https://example.osirus.ai/api/agents/AGENT_ID/v1",
    "provider_api_key": "YOUR_API_KEY"
  }' | jq .
```

Create a session and send a message:

```bash
curl -s -X POST http://localhost:4399/chat/sessions \
  -H "Content-Type: application/json" \
  -d '{"context":{"context_name":"Homepage","context_type":"page","context_id":"123"}}' | jq .

curl -s -X POST http://localhost:4399/chat/sessions/SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"Create a hero section with a call-to-action."}' | jq .
```

If bridge concurrency is saturated, `POST /chat/sessions/:id/messages` now returns either a bounded queued response or a busy error instead of allowing unbounded turn fan-out.

## Project Docs

- License: `LICENSE` (Apache 2.0)
- Security policy: `SECURITY.md`
- Changelog: `CHANGELOG.md`
- Notices: `NOTICE`
- Roadmap: `docs/roadmap.md`
