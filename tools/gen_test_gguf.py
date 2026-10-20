#!/usr/bin/env python3
"""Writes tests/data/quant.gguf and tests/data/quant_expected.f32 (run with python3 -I).

Usage: tools/gen_test_gguf.py [PARTS_DIR]

Q8_0, Q4_0, Q4_1, Q5_0 and Q5_1 tensors come from the gguf library's
quantizer; F16 from numpy. K-quant blocks (Q2_K to Q6_K) are copied from real
models: PARTS_DIR holds the first megabytes of TinyLlama's Q2_K, Q3_K_M, Q4_K_M
and Q5_K_M GGUF files (fetched with HTTP range requests), and the first blocks
of one tensor of each type are kept. The expected values are the gguf
library's dequantization, all tensors one after another as float32.
"""
import os
import struct
import sys

import numpy as np
import gguf
from gguf import quants

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "tests", "data")
T = gguf.GGMLQuantizationType


def read_tensors(path):
    """Tensor infos of a (possibly truncated) GGUF file: name -> (type, dims, absolute offset)."""
    d = open(path, "rb").read()
    o = 4
    _, nt, nkv = struct.unpack_from("<IQQ", d, o)
    o += 20
    align = 32

    def s(o):
        n = struct.unpack_from("<Q", d, o)[0]
        return d[o + 8:o + 8 + n].decode("utf-8", "replace"), o + 8 + n

    sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}

    def skip(o, t):
        if t == 8:
            return s(o)[1]
        if t == 9:
            et, n = struct.unpack_from("<IQ", d, o)
            o += 12
            for _ in range(n):
                o = skip(o, et)
            return o
        return o + sizes[t]

    for _ in range(nkv):
        k, o = s(o)
        t = struct.unpack_from("<I", d, o)[0]
        o += 4
        if k == "general.alignment":
            align = struct.unpack_from("<I", d, o)[0]
        o = skip(o, t)
    infos = []
    for _ in range(nt):
        name, o = s(o)
        nd = struct.unpack_from("<I", d, o)[0]
        o += 4
        dims = struct.unpack_from("<%dQ" % nd, d, o)
        o += 8 * nd
        t, off = struct.unpack_from("<IQ", d, o)
        o += 12
        infos.append((name, t, dims, off))
    base = (o + align - 1) // align * align
    return d, [(n, t, dims, base + off) for n, t, dims, off in infos]


def main():
    parts = sys.argv[1] if len(sys.argv) > 1 else None
    rng = np.random.default_rng(7)
    w = gguf.GGUFWriter(os.path.join(OUT, "quant.gguf"), "llama")
    expected = []
    src = (rng.standard_normal((4, 256)) * 0.1).astype(np.float32)
    w.add_tensor("f16", src.astype(np.float16))
    expected.append(src.astype(np.float16).astype(np.float32).ravel())
    for name in ("Q8_0", "Q4_0", "Q4_1", "Q5_0", "Q5_1"):
        q = quants.quantize(src, T[name])
        w.add_tensor(name.lower(), q, raw_dtype=T[name])
        expected.append(quants.dequantize(q, T[name]).astype(np.float32).ravel())
    if parts:
        want = {"Q2_K": None, "Q3_K": None, "Q4_K": None, "Q5_K": None, "Q6_K": None}
        for f in ("Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M"):
            d, infos = read_tensors(os.path.join(parts, f + ".part"))
            for n, t, dims, off in infos:
                tn = T(t).name
                if tn in want and want[tn] is None and off + 8 * 300 <= len(d):
                    bsize = {"Q2_K": 84, "Q3_K": 110, "Q4_K": 144, "Q5_K": 176, "Q6_K": 210}[tn]
                    want[tn] = np.frombuffer(d[off:off + 8 * bsize], dtype=np.uint8).copy()
        for tn, raw in want.items():
            if raw is None:
                print("no", tn, "blocks found")
                continue
            q = raw.reshape(8, -1)
            w.add_tensor(tn.lower(), q, raw_dtype=T[tn])
            expected.append(quants.dequantize(q, T[tn]).astype(np.float32).ravel())
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()
    np.concatenate(expected).astype("<f4").tofile(os.path.join(OUT, "quant_expected.f32"))


main()
