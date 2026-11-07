#!/bin/sh
# Compares every struct's size and field offsets in src/raw.esk with the C compiler's.
# Usage: tools/layout_check.sh INCLUDE_DIR [LIB_DIR]
#        tools/layout_check.sh --web     (the emdawnwebgpu section: emcc and node on PATH)
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
eskiuc=${ESKIUC:-eskiuc}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ "$1" = "--web" ]; then
    sed 's/^import <gpu\/raw>;//' "$root/tools/layout/layout_web.esk" > "$tmp/layout.esk"
    emcc --use-port=emdawnwebgpu "$root/tools/layout/layout_web.c" -o "$tmp/c.js"
    "$eskiuc" "$tmp/layout.esk" "$root/src/raw.esk" --target wasm32-unknown-emscripten -o "$tmp/e.js"
    node "$tmp/c.js" > "$tmp/c.txt"
    node "$tmp/e.js" > "$tmp/e.txt"
else
    sed 's/^import <gpu\/raw>;//' "$root/tools/layout/layout.esk" > "$tmp/layout.esk"
    inc=$1
    lib=${2:-$inc/../lib}
    "${CC:-cc}" -I"$inc" -I"$inc/webgpu-headers" "$root/tools/layout/layout.c" -o "$tmp/c"
    "$eskiuc" "$tmp/layout.esk" "$root/src/raw.esk" -o "$tmp/e" -L"$lib"
    "$tmp/c" > "$tmp/c.txt"
    "$tmp/e" > "$tmp/e.txt"
fi
diff "$tmp/c.txt" "$tmp/e.txt"
echo "layout ok: $(wc -l < "$tmp/c.txt" | tr -d ' ') sizes and offsets"
