#!/usr/bin/env python3
"""Compares the scenes tools/render_scenes.esk printed on several backends.

Usage: python3 -I tools/compare_scenes.py reference.txt other.txt... [--png DIR]

For each scene of each other output it prints the largest difference of a channel
(0 to 255), how many pixels differ by more than 1 and by more than 8, and the
share of pixels that differ at all. --png writes reference | other | difference
strips into DIR.
"""
import pathlib
import struct
import sys
import zlib


def load(path):
    scenes = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if line.startswith("SCENE "):
            _, name, w, h, data = line.split(" ", 4)
            scenes[name] = (int(w), int(h), bytes.fromhex(data.strip()))
        elif line.startswith("ERROR") or line.startswith("error"):
            print(f"{path}: {line}")
    return scenes


def png(path, w, h, rgba):
    rows = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    pathlib.Path(path).write_bytes(data)


def main():
    args = sys.argv[1:]
    out = None
    if "--png" in args:
        i = args.index("--png")
        out = pathlib.Path(args[i + 1])
        out.mkdir(parents=True, exist_ok=True)
        del args[i:i + 2]
    ref_path, others = args[0], args[1:]
    ref = load(ref_path)
    worst = 0
    for other_path in others:
        other = load(other_path)
        print(f"{other_path} against {ref_path}:")
        for name, (w, h, a) in ref.items():
            if name not in other:
                print(f"  {name:18} missing")
                worst = 255
                continue
            b = other[name][2]
            diff = [abs(x - y) for x, y in zip(a, b)]
            px = [max(diff[i:i + 4]) for i in range(0, len(diff), 4)]
            big = max(px)
            worst = max(worst, big)
            over1 = sum(1 for d in px if d > 1)
            over8 = sum(1 for d in px if d > 8)
            changed = sum(1 for d in px if d > 0)
            print(f"  {name:18} max {big:3}  >1: {over1:5}  >8: {over8:5}  changed {100.0 * changed / len(px):5.2f}%")
            if out:
                strip = bytearray()
                for y in range(h):
                    for img in (a, b):
                        strip += img[y * w * 4:(y + 1) * w * 4]
                    for x in range(w):
                        d = min(255, px[y * w + x] * 16)
                        strip += bytes((d, d, d, 255))
                tag = pathlib.Path(other_path).stem
                png(out / f"{name}-{tag}.png", w * 3, h, bytes(strip))
    return 0 if worst <= 255 else 1


if __name__ == "__main__":
    sys.exit(main())
