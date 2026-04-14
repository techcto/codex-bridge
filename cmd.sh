#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="${REPO_ROOT}/vscode-extension"
RUNTIME_STAGE_ROOT="${REPO_ROOT}/tools/codex-runtime"
DEFAULT_CODEX_SOURCE_DIR="${REPO_ROOT}/../codex/codex-rs"
CODEX_SOURCE_DIR="${CODEX_SOURCE_DIR:-${DEFAULT_CODEX_SOURCE_DIR}}"

require_cmd() {
  local name="$1"
  local message="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$message"
    return 1
  fi
}

bundle_runtime() {
  local platform="$1"
  local source_path="$2"
  local extension_source
  extension_source="$(cd "$(dirname "$source_path")" && pwd)/$(basename "$source_path")"

  if [ ! -f "$extension_source" ]; then
    echo "Runtime executable not found: $source_path"
    return 1
  fi

  (
    cd "$EXTENSION_DIR" || exit 1
    npm run prepare:bundled-runtime -- --source "$extension_source" --platform "$platform"
    npm run build:bundle-manifest
  )
}

codexbridgebundle() {
  local platform="${1:-}"
  local source_path="${2:-}"

  if [ -z "$platform" ] || [ -z "$source_path" ]; then
    echo "Usage: ./cmd.sh codexbridgebundle <platform-arch> <path-to-codex>"
    echo "Example: ./cmd.sh codexbridgebundle win32-x64 /abs/path/to/codex.exe"
    return 1
  fi

  require_cmd node "Node.js is required to bundle the Codex runtime." || return 1
  require_cmd npm "npm is required to bundle the Codex runtime." || return 1

  echo "Preparing bundled Codex runtime..."
  echo "Platform: $platform"
  echo "Source: $source_path"
  bundle_runtime "$platform" "$source_path"
}

codexbridgebundlewin() { codexbridgebundle "win32-x64" "$1"; }
codexbridgebundlelinux() { codexbridgebundle "linux-x64" "$1"; }
codexbridgebundlemac() { codexbridgebundle "darwin-arm64" "$1"; }

codexbridgebundlemanifest() {
  require_cmd node "Node.js is required to regenerate the bundled runtime manifest." || return 1
  require_cmd npm "npm is required to regenerate the bundled runtime manifest." || return 1
  (
    cd "$EXTENSION_DIR" || exit 1
    npm run build:bundle-manifest
  )
}

codexruntimebuild() {
  local platform="${1:-}"
  local binary_name="codex"
  local cargo_target=""
  local cargo_toolchain=""
  local rust_host=""
  local build_output=""
  local target_dir="${RUNTIME_STAGE_ROOT}/${platform}"
  local cargo_args=("-p" "codex-cli")
  local cargo_cmd=("cargo")

  if [ -z "$platform" ]; then
    echo "Usage: ./cmd.sh codexruntimebuild <platform-arch>"
    echo "Example: ./cmd.sh codexruntimebuild win32-x64"
    return 1
  fi

  if [ ! -d "$CODEX_SOURCE_DIR" ]; then
    echo "Codex source directory not found: $CODEX_SOURCE_DIR"
    echo "Set CODEX_SOURCE_DIR or check out the codex source next to codex-bridge."
    return 1
  fi

  require_cmd cargo "cargo is required to build Codex from source." || return 1
  rust_host="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"

  case "$platform" in
    win32-*)
      binary_name="codex.exe"
      cargo_target="x86_64-pc-windows-msvc"
      cargo_toolchain="stable-x86_64-pc-windows-msvc"
      if [[ "$rust_host" == *windows-gnu ]]; then
        echo "Detected Rust GNU toolchain ($rust_host)."
        echo "Codex runtime builds on Windows are more reliable with the MSVC toolchain."
        echo "Recommended:"
        echo "  rustup toolchain install stable-x86_64-pc-windows-msvc"
        echo "  rustup default stable-x86_64-pc-windows-msvc"
        echo "  Then install Visual Studio Build Tools with Desktop development with C++."
        return 1
      fi
      ;;
  esac

  echo "Building Codex runtime from source..."
  echo "Source: $CODEX_SOURCE_DIR"
  echo "Platform tag: $platform"
  echo "Stage dir: $target_dir"

  if [ -n "$cargo_target" ]; then
    cargo_args+=("--target" "$cargo_target")
    echo "Cargo target: $cargo_target"
  fi

  if [ -n "$cargo_toolchain" ]; then
    echo "Cargo toolchain: $cargo_toolchain"
    cargo_cmd=("rustup" "run" "$cargo_toolchain" "cargo")
  fi

  (
    cd "$CODEX_SOURCE_DIR" || exit 1
    "${cargo_cmd[@]}" build "${cargo_args[@]}"
  )

  if [ -n "$cargo_target" ]; then
    build_output="$CODEX_SOURCE_DIR/target/$cargo_target/debug/$binary_name"
  else
    build_output="$CODEX_SOURCE_DIR/target/debug/$binary_name"
  fi

  if [ ! -f "$build_output" ]; then
    echo "Expected build artifact not found: $build_output"
    return 1
  fi

  mkdir -p "$target_dir"
  cp "$build_output" "$target_dir/$binary_name"
  echo "Staged runtime at tools/codex-runtime/$platform/$binary_name"
}

codexruntimebuildwin() { codexruntimebuild "win32-x64"; }
codexruntimebuildlinux() { codexruntimebuild "linux-x64"; }
codexruntimebuildmac() { codexruntimebuild "darwin-arm64"; }

maybe_bundle_default_windows_runtime() {
  local default_windows_runtime="${RUNTIME_STAGE_ROOT}/win32-x64/codex.exe"
  if [ -f "$default_windows_runtime" ]; then
    echo "Detected Windows Codex runtime at tools/codex-runtime/win32-x64/codex.exe"
    codexbridgebundle "win32-x64" "$default_windows_runtime"
  fi
}

codexbridgevscodebuild() {
  require_cmd node "Node.js is required to build the Codex Bridge VS Code extension." || return 1
  require_cmd npm "npm is required to build the Codex Bridge VS Code extension." || return 1
  echo "Building Codex Bridge VS Code extension..."
  echo "Directory: ${EXTENSION_DIR#$REPO_ROOT/}"
  maybe_bundle_default_windows_runtime
  (
    cd "$EXTENSION_DIR" || exit 1
    npm install
    npm run build
  )
}

codexbridgevscodepackage() {
  require_cmd node "Node.js is required to package the Codex Bridge VS Code extension." || return 1
  require_cmd npm "npm is required to package the Codex Bridge VS Code extension." || return 1
  echo "Packaging Codex Bridge VS Code extension..."
  echo "Directory: ${EXTENSION_DIR#$REPO_ROOT/}"
  maybe_bundle_default_windows_runtime
  (
    cd "$EXTENSION_DIR" || exit 1
    npm install
    npm run build
    npm run package:vsix
  )
}

codexbridgeup() {
  (cd "$REPO_ROOT" && docker compose up -d)
}

codexbridgedown() {
  (cd "$REPO_ROOT" && docker compose down)
}

codexbridgelogs() {
  (cd "$REPO_ROOT" && docker compose logs -f)
}

codexbridgerestart() {
  (cd "$REPO_ROOT" && docker compose restart)
}

show_help() {
  cat <<'EOF'
Codex Bridge helper commands

  ./cmd.sh codexruntimebuildwin
  ./cmd.sh codexruntimebuildlinux
  ./cmd.sh codexruntimebuildmac
  ./cmd.sh codexbridgebundle <platform-arch> <path-to-codex>
  ./cmd.sh codexbridgebundlewin <path-to-codex.exe>
  ./cmd.sh codexbridgebundlelinux <path-to-codex>
  ./cmd.sh codexbridgebundlemac <path-to-codex>
  ./cmd.sh codexbridgebundlemanifest
  ./cmd.sh codexbridgevscodebuild
  ./cmd.sh codexbridgevscodepackage
  ./cmd.sh codexbridgeup
  ./cmd.sh codexbridgedown
  ./cmd.sh codexbridgelogs
  ./cmd.sh codexbridgerestart

Optional env:
  CODEX_SOURCE_DIR=/abs/path/to/codex/codex-rs
EOF
}

command_name="${1:-help}"
shift || true

case "$command_name" in
  codexbridgebundle) codexbridgebundle "$@" ;;
  codexbridgebundlewin) codexbridgebundlewin "$@" ;;
  codexbridgebundlelinux) codexbridgebundlelinux "$@" ;;
  codexbridgebundlemac) codexbridgebundlemac "$@" ;;
  codexbridgebundlemanifest) codexbridgebundlemanifest "$@" ;;
  codexruntimebuild) codexruntimebuild "$@" ;;
  codexruntimebuildwin) codexruntimebuildwin "$@" ;;
  codexruntimebuildlinux) codexruntimebuildlinux "$@" ;;
  codexruntimebuildmac) codexruntimebuildmac "$@" ;;
  codexbridgevscodebuild) codexbridgevscodebuild "$@" ;;
  codexbridgevscodepackage) codexbridgevscodepackage "$@" ;;
  codexbridgeup) codexbridgeup "$@" ;;
  codexbridgedown) codexbridgedown "$@" ;;
  codexbridgelogs) codexbridgelogs "$@" ;;
  codexbridgerestart) codexbridgerestart "$@" ;;
  help|-h|--help|'') show_help ;;
  *)
    echo "Unknown command: $command_name"
    show_help
    exit 1
    ;;
esac
