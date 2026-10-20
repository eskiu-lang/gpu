#!/usr/bin/env python3
"""Writes the glTF test models in tests/data/ (run with python3 -I).

textured_quad.glb: a 2x2 quad facing +Z with a 4x4 PNG texture (red, green,
blue and white quadrants), a nearest sampler, KHR_materials_unlit, and
positions stored as a sparse accessor over a zero-filled view.

skin_anim.gltf: a skinned strip (triangle strip mode) over two joints, with
the buffer embedded as base64, and one animation with a LINEAR rotation, a
STEP translation and a CUBICSPLINE scale.
"""
import base64
import json
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "tests", "data")


def png(w, h, rgba):
    raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def pad4(b, fill=b"\x00"):
    return b + fill * ((4 - len(b) % 4) % 4)


class Builder:
    def __init__(self):
        self.bin = b""
        self.views = []
        self.accessors = []

    def view(self, data, target=None, stride=None):
        self.bin = pad4(self.bin)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        if stride:
            v["byteStride"] = stride
        self.bin += data
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, view, ctype, count, kind, **extra):
        a = {"bufferView": view, "componentType": ctype, "count": count, "type": kind}
        if view is None:
            del a["bufferView"]
        a.update(extra)
        self.accessors.append(a)
        return len(self.accessors) - 1


def floats(xs):
    return struct.pack("<%df" % len(xs), *xs)


def textured_quad():
    b = Builder()
    pos = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]
    zeros = b.view(floats([0.0] * 12), 34962)
    sp_idx = b.view(struct.pack("<4H", 0, 1, 2, 3))
    sp_val = b.view(floats(pos))
    pa = b.accessor(zeros, 5126, 4, "VEC3", min=[-1, -1, 0], max=[1, 1, 0],
                    sparse={"count": 4, "indices": {"bufferView": sp_idx, "componentType": 5123},
                            "values": {"bufferView": sp_val}})
    na = b.accessor(b.view(floats([0, 0, 1] * 4), 34962), 5126, 4, "VEC3")
    ua = b.accessor(b.view(floats([0, 1, 1, 1, 1, 0, 0, 0]), 34962), 5126, 4, "VEC2")
    ia = b.accessor(b.view(struct.pack("<6H", 0, 1, 2, 0, 2, 3), 34963), 5123, 6, "SCALAR")
    px = []
    for y in range(4):
        for x in range(4):
            if y < 2:
                px += [255, 0, 0, 255] if x < 2 else [0, 255, 0, 255]
            else:
                px += [0, 0, 255, 255] if x < 2 else [255, 255, 255, 255]
    img = b.view(png(4, 4, bytes(px)))
    j = {
        "asset": {"version": "2.0", "generator": "tools/gen_test_models.py"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "quad"}],
        "meshes": [{"name": "quad", "primitives": [{"attributes": {"POSITION": pa, "NORMAL": na, "TEXCOORD_0": ua},
                                                    "indices": ia, "material": 0}]}],
        "materials": [{"name": "unlit", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}},
                       "extensions": {"KHR_materials_unlit": {}}}],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": img, "mimeType": "image/png"}],
        "buffers": [{"byteLength": len(pad4(b.bin))}],
        "bufferViews": b.views, "accessors": b.accessors,
    }
    js = pad4(json.dumps(j, separators=(",", ":")).encode(), b" ")
    bn = pad4(b.bin)
    glb = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(bn))
    glb += struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(bn), b"BIN\x00") + bn
    with open(os.path.join(OUT, "textured_quad.glb"), "wb") as f:
        f.write(glb)


def skin_anim():
    b = Builder()
    pos = [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0, -0.5, 2, 0, 0.5, 2, 0]
    pa = b.accessor(b.view(floats(pos), 34962), 5126, 6, "VEC3", min=[-0.5, 0, 0], max=[0.5, 2, 0])
    joints = b.accessor(b.view(bytes([0, 0, 0, 0] * 2 + [0, 1, 0, 0] * 2 + [1, 0, 0, 0] * 2), 34962), 5121, 6, "VEC4")
    weights = b.accessor(b.view(floats([1, 0, 0, 0] * 2 + [0.5, 0.5, 0, 0] * 2 + [1, 0, 0, 0] * 2), 34962), 5126, 6, "VEC4")
    ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    down = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]
    ibm = b.accessor(b.view(floats(ident + down)), 5126, 2, "MAT4")
    t_rot = b.accessor(b.view(floats([0, 1])), 5126, 2, "SCALAR", min=[0], max=[1])
    s = 0.70710678
    rot = b.accessor(b.view(floats([0, 0, 0, 1, 0, 0, s, s])), 5126, 2, "VEC4")
    tr = b.accessor(b.view(floats([0, 0, 0, 1, 0, 0])), 5126, 2, "VEC3")
    t_sc = b.accessor(b.view(floats([0, 2])), 5126, 2, "SCALAR", min=[0], max=[2])
    sc = b.accessor(b.view(floats([0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0])), 5126, 6, "VEC3")
    j = {
        "asset": {"version": "2.0", "generator": "tools/gen_test_models.py"},
        "scene": 0, "scenes": [{"nodes": [0, 1]}],
        "nodes": [{"mesh": 0, "skin": 0, "name": "strip"},
                  {"name": "root_joint", "children": [2]},
                  {"name": "tip_joint", "translation": [0, 1, 0]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": pa, "JOINTS_0": joints, "WEIGHTS_0": weights}, "mode": 5}]}],
        "skins": [{"joints": [1, 2], "inverseBindMatrices": ibm}],
        "animations": [{"name": "bend", "samplers": [
            {"input": t_rot, "output": rot, "interpolation": "LINEAR"},
            {"input": t_rot, "output": tr, "interpolation": "STEP"},
            {"input": t_sc, "output": sc, "interpolation": "CUBICSPLINE"}],
            "channels": [{"sampler": 0, "target": {"node": 2, "path": "rotation"}},
                         {"sampler": 1, "target": {"node": 1, "path": "translation"}},
                         {"sampler": 2, "target": {"node": 1, "path": "scale"}}]}],
        "buffers": [{"byteLength": len(b.bin), "uri": "data:application/octet-stream;base64," + base64.b64encode(b.bin).decode()}],
        "bufferViews": b.views, "accessors": b.accessors,
    }
    with open(os.path.join(OUT, "skin_anim.gltf"), "w") as f:
        json.dump(j, f, indent=1)


os.makedirs(OUT, exist_ok=True)
textured_quad()
skin_anim()
