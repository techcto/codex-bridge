# Bundled Runtime

Place platform-specific Codex executables here when packaging the VS Code extension with a bundled local runtime.

Expected layout:

- `bundled-runtime/win32-x64/codex.exe`
- `bundled-runtime/win32-arm64/codex.exe`
- `bundled-runtime/linux-x64/codex`
- `bundled-runtime/linux-arm64/codex`
- `bundled-runtime/darwin-x64/codex`
- `bundled-runtime/darwin-arm64/codex`

Helper commands:

```bash
npm run prepare:bundled-runtime -- --source /absolute/path/to/codex.exe --platform win32-x64
npm run build
```

From the `codex-bridge` repo root:

```bash
./cmd.sh codexruntimebuildwin
./cmd.sh codexruntimebuildlinux
./cmd.sh codexbridgebundlewin /absolute/path/to/codex.exe
./cmd.sh codexbridgebundlelinux /absolute/path/to/codex
./cmd.sh codexbridgebundlemanifest
./cmd.sh codexbridgevscodebuild
./cmd.sh codexbridgevscodepackage
```

If your Codex source is not checked out next to `codex-bridge` as `../codex/codex-rs`, set `CODEX_SOURCE_DIR` when using the runtime build commands.

`npm run build` regenerates `bundled-runtime/manifest.json` so the packaged extension can report which runtimes are present.
