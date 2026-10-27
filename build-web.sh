#!/usr/bin/env bash
set -euo pipefail

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "Install wasm-bindgen-cli 0.2.121 first: cargo install wasm-bindgen-cli --version 0.2.121 --locked" >&2
  exit 1
fi

cargo build --release --target wasm32-unknown-unknown
wasm-bindgen \
  target/wasm32-unknown-unknown/release/pleaseask.wasm \
  --target web \
  --out-dir web/wasm

echo "Built web/. Serve it from an HTTPS static host, or use localhost for testing."
