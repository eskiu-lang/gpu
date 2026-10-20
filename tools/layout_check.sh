#!/bin/sh
# Compares every struct's size and field offsets in src/raw.esk with the C compiler's.
# Usage: tools/layout_check.sh INCLUDE_DIR [LIB_DIR]
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
inc=$1
lib=${2:-$inc/../lib}
cc=${CC:-cc}
eskiuc=${ESKIUC:-eskiuc}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$cc" -I"$inc" -I"$inc/webgpu-headers" "$root/tools/layout/layout.c" -o "$tmp/c"
sed 's/^import <gpu\/raw>;//' "$root/tools/layout/layout.esk" > "$tmp/layout.esk"
"$eskiuc" "$tmp/layout.esk" "$root/src/raw.esk" -o "$tmp/e" -L"$lib"
"$tmp/c" > "$tmp/c.txt"
"$tmp/e" > "$tmp/e.txt"
diff "$tmp/c.txt" "$tmp/e.txt"
echo "layout ok: $(wc -l < "$tmp/c.txt" | tr -d ' ') sizes and offsets"
