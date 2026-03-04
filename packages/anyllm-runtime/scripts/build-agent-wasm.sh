#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
GO_DIR="$ROOT_DIR/packages/anyllm-runtime/agent-runtime-go"
OUT_DIR="$ROOT_DIR/packages/anyllm-runtime/src"

mkdir -p "$OUT_DIR"

cd "$GO_DIR"
go mod tidy
GOOS=js GOARCH=wasm go build -o "$OUT_DIR/agent.wasm" ./main.go
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT_DIR/wasm_exec.js"

echo "Built WASM runtime to $OUT_DIR/agent.wasm"
