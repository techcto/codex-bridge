# Codex Bridge

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Docker Compose](https://img.shields.io/badge/docker-compose-available-brightgreen.svg)](docker-compose.yml)
[![Runtime](https://img.shields.io/badge/runtime-app__server__adapter-6c5ce7.svg)](#environment)

This repo provides a CMS-friendly Codex runtime bridge. It exposes a small REST + SSE surface that content platforms can call for chat sessions, auth, runtime info, and streaming events. OpenAI is the primary default path, Osirus is the next featured provider, and other OpenAI-compatible backends remain supported.

Supported runtime providers, in recommended order:

- `openai`
- `osirus`
- `osirus_agent`
- `ollama`
- `vllm`
- `openai_compatible`

## Why This Exists

Most CMS platforms need Codex to fit into their own auth, UI, and content workflows. This bridge keeps the integration light: the CMS owns permissions and content actions, while the runtime focuses on execution and streaming.

## Grant Pitch

The Codex Bridge enables open, interoperable AI editing for CMS platforms without vendor lock-in. It reduces integration time from weeks to hours, supports local or cloud models via OpenAI-compatible routes, and keeps platform-specific permissions and content workflows in the CMS where they belong. Funding will help us harden the runtime, improve performance, and deliver plug-and-play adapters for popular CMS stacks.

## What’s Inside

- `server.mjs`: main bridge service (Node.js)
- `app-server-client.mjs`: client utilities for the app-server adapter runtime
- `vscode-extension/`: VS Code extension, bundled-runtime helpers, and packaging flow
- `cmd.sh`: bridge-local helper commands for runtime builds, extension packaging, and Docker workflows

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

The VS Code extension build will automatically bundle the Windows runtime if it finds:

```text
tools/codex-runtime/win32-x64/codex.exe
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
