#!/usr/bin/env bash
# Build Rust/WASM artifacts for both Node.js (tests) and browser (web).
# Run this whenever you change code under rust/src/.
# Output directories are gitignored in this repo; deploy via
# scripts/sync-github-pages.js which copies pkg-web into slaymaker1907.github.io.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$REPO_DIR/rust"

echo "[build-wasm] Building nodejs target..."
wasm-pack build "$RUST_DIR" --target nodejs --out-dir pkg-node --release

echo "[build-wasm] Building web target..."
wasm-pack build "$RUST_DIR" --target web --out-dir pkg-web --release

echo "[build-wasm] Building no-modules target (classic worker)..."
wasm-pack build "$RUST_DIR" --target no-modules --out-dir pkg-no-modules --release

echo "[build-wasm] Done. Artifacts in rust/pkg-node/, rust/pkg-web/, and rust/pkg-no-modules/"
