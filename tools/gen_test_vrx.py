#!/usr/bin/env python3
"""Writes the .vrx test model in tests/data/ (run with python3 -I).

quad.vrx: a zlib-compressed viro.Node protobuf, as ViroReact's ViroFBX tool writes it.
The outer node holds a skeleton of two bones (the first with no parent field, so its
parent reads as itself, as in Viro's own files) and two nodes: "quad", positioned at
(1, 2, 3) and turned 90 degrees about Y, and "empty", with no geometry.

quad's geometry is four interleaved vertices (position, texture coordinate, normal; 32
bytes each) and two elements: a triangle strip over all four (16-bit indices) and one
triangle (32-bit indices). The first element's material is physically based with an
RGBA diffuse texture (vrx_alpha.png), a roughness map (vrx_rough.png, red 10, 20, 30, 40)
and a metalness of 0.25 without a map; the second is Constant with transparency 0.5.
The skin binds vertex weights 0.5/0.5 to bones 0 and 1 (bone 1's bind transform moves
down by 1). Its skeletal animation "move" (2000 ms) has two legacy frames moving bone 1
up by 1 and by 2; a keyframe animation also called "move" moves the node from z 3 to z 5.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "tests", "data")


def png(w, h, rgba, color_type=6):
    n = 4 if color_type == 6 else 3
    raw = b"".join(b"\x00" + rgba[y * w * n:(y + 1) * w * n] for y in range(h))

    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def varint(v):
    out = b""
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def tag(field, wire):
    return varint(field << 3 | wire)


def f_int(field, v):
    return tag(field, 0) + varint(v)


def f_float(field, v):
    return tag(field, 5) + struct.pack("<f", v)


def f_bytes(field, b):
    return tag(field, 2) + varint(len(b)) + b


def f_floats(field, vs):
    return f_bytes(field, b"".join(struct.pack("<f", v) for v in vs))


def f_ints(field, vs):
    return f_bytes(field, b"".join(varint(v) for v in vs))


def matrix(m):
    return f_floats(1, m)


def translate(x, y, z):
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]


IDENTITY = translate(0, 0, 0)


def source(semantic, count, comps, offset, stride, data=None, floats=True):
    b = b""
    if semantic:
        b += f_int(1, semantic)
    b += f_int(2, count)
    if floats:
        b += f_int(3, 1)
    b += f_int(4, comps) + f_int(5, 4)
    if offset:
        b += f_int(6, offset)
    b += f_int(7, stride)
    if data is not None:
        b += f_bytes(8, data)
    return b


def visual(color=None, texture=None):
    b = b""
    if color is not None:
        b += f_floats(1, color)
    if texture is not None:
        b += f_bytes(2, texture.encode())
    b += f_float(3, 1.0)
    # repeat, linear, linear, linear mipmaps
    b += f_int(5, 1) + f_int(6, 1) + f_int(7, 2) + f_int(8, 2) + f_int(9, 2)
    return b


def main():
    verts = [(-1, -1, 0, 0, 1), (1, -1, 0, 1, 1), (-1, 1, 0, 0, 0), (1, 1, 0, 1, 0)]
    data = b"".join(struct.pack("<8f", x, y, z, u, v, 0, 0, 1) for x, y, z, u, v in verts)
    geo = f_bytes(1, b"quad_geo") + f_bytes(2, data)
    geo += f_bytes(3, source(0, 4, 3, 0, 32))
    geo += f_bytes(3, source(3, 4, 2, 12, 32))
    geo += f_bytes(3, source(1, 4, 3, 20, 32))
    geo += f_bytes(4, f_bytes(1, struct.pack("<4H", 0, 1, 2, 3)) + f_int(2, 1) + f_int(3, 2) + f_int(4, 2))
    geo += f_bytes(4, f_bytes(1, struct.pack("<3I", 0, 2, 1)) + f_int(3, 1) + f_int(4, 4))
    pbr = (f_bytes(1, b"pbr") + f_float(4, 1.0) + f_int(5, 4) + f_bytes(11, visual([0.5, 0.5, 0.5], "vrx_alpha.png"))
           + f_bytes(17, visual([0.33], "vrx_rough.png")) + f_bytes(18, visual([0.25])))
    flat = f_bytes(1, b"flat") + f_float(4, 0.5) + f_int(5, 0) + f_bytes(11, visual([0.2, 0.6, 0.9]))
    geo += f_bytes(5, pbr) + f_bytes(5, flat)
    bone_idx = b"".join(struct.pack("<4I", 0, 1, 0, 0) for _ in verts)
    bone_w = b"".join(struct.pack("<4f", 0.5, 0.5, 0, 0) for _ in verts)
    skin = f_bytes(1, matrix(IDENTITY)) + f_bytes(2, matrix(IDENTITY)) + f_bytes(2, matrix(translate(0, -1, 0)))
    skin += f_bytes(3, source(8, 4, 4, 0, 16, bone_idx, floats=False))
    skin += f_bytes(4, source(7, 4, 4, 0, 16, bone_w))
    geo += f_bytes(6, skin)

    def skel_frame(t, y):
        b = f_float(1, t) if t else b""
        return b + f_ints(2, [1]) + f_bytes(3, matrix(translate(0, y, 0)))
    skel = f_bytes(1, b"move") + f_bytes(2, skel_frame(0.0, 1.0)) + f_bytes(2, skel_frame(1.0, 2.0)) + f_int(3, 2000)

    def key_frame(t, z):
        b = f_float(1, t) if t else b""
        return b + f_floats(2, [1, 2, z]) + f_floats(3, [0, 0.70710678, 0, 0.70710678]) + f_floats(4, [1, 1, 1])
    keys = f_bytes(1, b"move") + f_bytes(2, key_frame(0.0, 3.0)) + f_bytes(2, key_frame(1.0, 5.0)) + f_int(3, 2000)

    quad = (f_bytes(1, b"quad") + f_floats(2, [1, 2, 3]) + f_floats(3, [1, 1, 1]) + f_floats(4, [0, 90, 0])
            + f_float(6, 1.0) + f_bytes(7, geo) + f_bytes(9, skel) + f_bytes(10, keys))
    empty = f_bytes(1, b"empty") + f_floats(2, [0, 0, 0]) + f_floats(3, [1, 1, 1]) + f_floats(4, [0, 0, 0])
    bones = f_bytes(1, f_bytes(1, b"root")) + f_bytes(1, f_bytes(1, b"tip") + f_int(2, 0))
    root = f_floats(2, [0, 0, 0]) + f_floats(3, [1, 1, 1]) + f_floats(4, [0, 0, 0]) + f_bytes(8, bones)
    root += f_bytes(13, quad) + f_bytes(13, empty)
    with open(os.path.join(OUT, "quad.vrx"), "wb") as f:
        f.write(zlib.compress(root))
    with open(os.path.join(OUT, "vrx_rough.png"), "wb") as f:
        f.write(png(2, 2, bytes([10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0]), color_type=2))
    with open(os.path.join(OUT, "vrx_alpha.png"), "wb") as f:
        f.write(png(1, 1, bytes([200, 100, 50, 128])))


if __name__ == "__main__":
    main()
