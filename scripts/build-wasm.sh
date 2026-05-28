#!/usr/bin/env bash
# Build Rust/WASM artifacts for both Node.js (tests) and browser (web).
# Run this whenever you change code under rust/src/.
# Output directories rust/pkg-node/ and rust/pkg-web/ are committed to the
# repo so no build step is required for deploy (see AGENTS.md).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$REPO_DIR/rust"

echo "[build-wasm] Building nodejs target..."
wasm-pack build "$RUST_DIR" --target nodejs --out-dir pkg-node --release

echo "[build-wasm] Building web target..."
wasm-pack build "$RUST_DIR" --target web --out-dir pkg-web --release

# wasm-pack writes a .gitignore that excludes *.wasm — remove it so the
# built artifacts are tracked by git as required by AGENTS.md.
rm -f "$RUST_DIR/pkg-node/.gitignore"
rm -f "$RUST_DIR/pkg-web/.gitignore"

echo "[build-wasm] Done. Artifacts in rust/pkg-node/ and rust/pkg-web/"
