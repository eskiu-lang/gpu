#!/bin/sh
# Builds web/gpu-naga.wasm, the WGSL to GLSL ES 3.00 translator of the WebGL2 backend, from
# tools/naga-wasm (naga's WGSL reader and GLSL writer behind a C ABI). Needs Rust with the
# wasm32-unknown-unknown target and, to shrink the module, binaryen's wasm-opt (emsdk has
# it in upstream/bin).
#
#     rustup target add wasm32-unknown-unknown
#     tools/naga_wasm.sh
set -e
cd "$(dirname "$0")/naga-wasm"
# Panic locations keep source paths: strip the home directory so none of them name the
# machine that built the module.
RUSTFLAGS="--remap-path-prefix=$HOME=~ $RUSTFLAGS" cargo build --release --target wasm32-unknown-unknown
out=../../web/gpu-naga.wasm
wasm=target/wasm32-unknown-unknown/release/gpu_naga.wasm
opt=$(command -v wasm-opt || true)
if [ -z "$opt" ] && [ -n "$EMSDK" ] && [ -x "$EMSDK/upstream/bin/wasm-opt" ]; then opt="$EMSDK/upstream/bin/wasm-opt"; fi
if [ -n "$opt" ]; then
    "$opt" -Oz --all-features --strip-debug "$wasm" -o "$out"
else
    cp "$wasm" "$out"
fi
ls -l "$out"
