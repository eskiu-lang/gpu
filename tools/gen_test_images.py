#!/usr/bin/env python3
# Generates the PNG and JPEG test images in tests/data/ (run with python3 -I).
#
# PNGs are written by this script (zlib + struct only) in every color type and
# bit depth, with and without Adam7 interlacing, using all five row filters and
# the three deflate block kinds. Each NAME.png comes with NAME.rgba, the pixels
# the decoder must produce (RGBA8, rows packed, top row first).
#
# JPEGs are made with cjpeg from libjpeg-turbo (baseline, progressive, every
# chroma subsampling, restart markers, non-interleaved scans) and each NAME.jpg
# gets NAME.rgba from djpeg, the reference decode the tests compare against with
# a tolerance. When macOS sips is there it adds a file from Apple's encoder,
# and with ImageMagick a CMYK file. Files that the decoder must reject are
# written as NAME.bad.jpg.
#
# With --big DIR it also writes 1024x1024 timing images to DIR.

import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "tests", "data")


class Lcg:
    def __init__(self, seed):
        self.s = seed

    def next(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s >> 8


def chunk(kind, data):
    c = struct.pack(">I", len(data)) + kind + data
    return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def channels(ct):
    return {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]


def pack_row(samples, depth):
    if depth == 8:
        return bytes(samples)
    if depth == 16:
        return b"".join(struct.pack(">H", s) for s in samples)
    out = bytearray()
    acc = 0
    nbits = 0
    for s in samples:
        acc = (acc << depth) | s
        nbits += depth
        if nbits == 8:
            out.append(acc)
            acc = 0
            nbits = 0
    if nbits:
        out.append(acc << (8 - nbits))
    return bytes(out)


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def filter_rows(rows, bpp, first_filter):
    out = bytearray()
    prev = bytes(len(rows[0])) if rows else b""
    for i, row in enumerate(rows):
        ft = (first_filter + i) % 5
        out.append(ft)
        for x in range(len(row)):
            a = row[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if ft == 0:
                v = row[x]
            elif ft == 1:
                v = row[x] - a
            elif ft == 2:
                v = row[x] - b
            elif ft == 3:
                v = row[x] - ((a + b) >> 1)
            else:
                v = row[x] - paeth(a, b, c)
            out.append(v & 255)
        prev = row
    return bytes(out)


ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def raw_stream(pix, w, h, ct, depth, interlace):
    # pix[y][x] is a tuple of samples at the native depth.
    nch = channels(ct)
    bpp = max(1, nch * depth // 8)
    if not interlace:
        rows = [pack_row([s for x in range(w) for s in pix[y][x]], depth) for y in range(h)]
        return filter_rows(rows, bpp, 0)
    out = b""
    for p, (x0, y0, dx, dy) in enumerate(ADAM7):
        xs = list(range(x0, w, dx))
        ys = list(range(y0, h, dy))
        if not xs or not ys:
            continue
        rows = [pack_row([s for x in xs for s in pix[y][x]], depth) for y in ys]
        out += filter_rows(rows, bpp, p)
    return out


def compress(raw, mode):
    if mode == "stored":
        c = zlib.compressobj(0)
    elif mode == "fixed":
        c = zlib.compressobj(9, zlib.DEFLATED, 15, 9, zlib.Z_FIXED)
    else:
        c = zlib.compressobj(9)
    return c.compress(raw) + c.flush()


def to_rgba(pix, ct, depth, palette, trns):
    maxv = (1 << depth) - 1
    out = bytearray()
    for row in pix:
        for s in row:
            if ct == 3:
                r, g, b = palette[s[0]]
                a = trns[s[0]] if trns is not None and s[0] < len(trns) else 255
                out += bytes((r, g, b, a))
                continue
            if depth == 16:
                v = [x >> 8 for x in s]
            else:
                v = [x * 255 // maxv for x in s]
            if ct == 0:
                a = 0 if trns is not None and s[0] == trns else 255
                out += bytes((v[0], v[0], v[0], a))
            elif ct == 2:
                a = 0 if trns is not None and tuple(s) == trns else 255
                out += bytes((v[0], v[1], v[2], a))
            elif ct == 4:
                out += bytes((v[0], v[0], v[0], v[1]))
            else:
                out += bytes(v)
    return bytes(out)


def make_png(name, w, h, ct, depth, interlace=0, mode="dynamic", trns=False, split=0, seed=1):
    rnd = Lcg(seed)
    maxv = (1 << depth) - 1
    nch = channels(ct)
    palette = None
    plte_n = 0
    if ct == 3:
        plte_n = min(1 << depth, 200)
        palette = [((i * 37) & 255, (i * 91 + 13) & 255, (255 - i * 5) & 255) for i in range(plte_n)]
    pix = []
    for y in range(h):
        row = []
        for x in range(w):
            if ct == 3:
                row.append(((x + y * 3 + rnd.next() % 3) % plte_n,))
            else:
                s = []
                for c in range(nch):
                    if (x + y + c) % 4 == 0:
                        s.append(rnd.next() % (maxv + 1))
                    else:
                        s.append(((x * (c + 1) * maxv) // max(1, w - 1) + y * 3) % (maxv + 1))
                row.append(tuple(s))
        pix.append(row)
    tval = None
    extra = b""
    if trns:
        if ct == 0:
            tval = pix[0][0][0]
            extra = chunk(b"tRNS", struct.pack(">H", tval))
        elif ct == 2:
            tval = pix[0][0]
            extra = chunk(b"tRNS", struct.pack(">HHH", *tval))
        elif ct == 3:
            tval = bytes((i * 29) & 255 for i in range(plte_n // 2 + 1))
            extra = chunk(b"tRNS", tval)
    raw = raw_stream(pix, w, h, ct, depth, interlace)
    z = compress(raw, mode)
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, ct, 0, 0, interlace))
    out += chunk(b"tEXt", b"Comment\x00eskiu test image")
    if palette:
        out += chunk(b"PLTE", b"".join(bytes(p) for p in palette))
    out += extra
    if split:
        for i in range(0, len(z), split):
            out += chunk(b"IDAT", z[i:i + split])
    else:
        out += chunk(b"IDAT", z)
    out += chunk(b"IEND", b"")
    write(name + ".png", out)
    write(name + ".rgba", to_rgba(pix, ct, depth, palette, tval))


def write(name, data):
    with open(os.path.join(DATA, name), "wb") as f:
        f.write(data)


def jpeg_source(w, h, seed=7):
    # Smooth gradients, a few hard edges and some noise: something a camera
    # texture might hold.
    rnd = Lcg(seed)
    px = bytearray()
    for y in range(h):
        for x in range(w):
            r = (x * 255) // max(1, w - 1)
            g = (y * 255) // max(1, h - 1)
            b = 200 if ((x // 6) + (y // 5)) % 2 else 40
            if (x - w // 2) ** 2 + (y - h // 2) ** 2 < (min(w, h) // 3) ** 2:
                r, g, b = 250, 240 - x % 20, 30
            n = rnd.next() % 17 - 8
            px += bytes((max(0, min(255, r + n)), max(0, min(255, g - n)), max(0, min(255, b + n))))
    return px


def write_ppm(path, w, h, rgb):
    with open(path, "wb") as f:
        f.write(b"P6\n%d %d\n255\n" % (w, h) + bytes(rgb))


def read_pnm(path):
    data = open(path, "rb").read()
    fields = []
    i = 0
    while len(fields) < 4:
        while data[i:i + 1].isspace():
            i += 1
        j = i
        while not data[j:j + 1].isspace():
            j += 1
        fields.append(data[i:j])
        i = j
    i += 1
    w, h = int(fields[1]), int(fields[2])
    body = data[i:]
    out = bytearray()
    if fields[0] == b"P5":
        for v in body[:w * h]:
            out += bytes((v, v, v, 255))
    else:
        for k in range(w * h):
            out += body[k * 3:k * 3 + 3] + b"\xff"
    return w, h, bytes(out)


def make_jpeg(tmp, name, w, h, args, bad=False):
    ppm = os.path.join(tmp, "src.ppm")
    write_ppm(ppm, w, h, jpeg_source(w, h))
    jpg = os.path.join(DATA, name + (".bad.jpg" if bad else ".jpg"))
    subprocess.run(["cjpeg"] + args + ["-outfile", jpg, ppm], check=True)
    if bad:
        return
    out = os.path.join(tmp, "out.pnm")
    subprocess.run(["djpeg", "-pnm", "-outfile", out, jpg], check=True)
    rw, rh, rgba = read_pnm(out)
    assert (rw, rh) == (w, h)
    write(name + ".rgba", rgba)


def make_pngs():
    sizes = (13, 11)
    w, h = sizes
    for il in (0, 1):
        p = "i_" if il else ""
        for d in (1, 2, 4, 8, 16):
            make_png(p + "g%d" % d, w, h, 0, d, il)
        make_png(p + "g2_trns", w, h, 0, 2, il, trns=True)
        make_png(p + "g16_trns", w, h, 0, 16, il, trns=True)
        for d in (8, 16):
            make_png(p + "rgb%d" % d, w, h, 2, d, il)
            make_png(p + "rgb%d_trns" % d, w, h, 2, d, il, trns=True)
            make_png(p + "ga%d" % d, w, h, 4, d, il)
            make_png(p + "rgba%d" % d, w, h, 6, d, il)
        for d in (1, 2, 4, 8):
            make_png(p + "p%d" % d, w, h, 3, d, il)
        make_png(p + "p8_trns", w, h, 3, 8, il, trns=True)
    make_png("rgba8_stored", 21, 9, 6, 8, mode="stored", split=100)
    make_png("rgb8_fixed", 21, 9, 2, 8, mode="fixed")
    make_png("rgb8_split", 40, 17, 2, 8, split=7)
    make_png("i_1x1", 1, 1, 6, 8, 1)
    make_png("i_3x2", 3, 2, 2, 8, 1)
    make_png("g1_wide", 67, 3, 0, 1)


def make_jpegs():
    if shutil.which("cjpeg") is None or shutil.which("djpeg") is None:
        sys.exit("cjpeg and djpeg (libjpeg-turbo) are needed for the JPEG test files")
    with tempfile.TemporaryDirectory() as tmp:
        w, h = 37, 29
        make_jpeg(tmp, "j444", w, h, ["-quality", "90", "-sample", "1x1"])
        make_jpeg(tmp, "j422", w, h, ["-sample", "2x1"])
        make_jpeg(tmp, "j420", w, h, ["-sample", "2x2"])
        make_jpeg(tmp, "j440", w, h, ["-sample", "1x2"])
        make_jpeg(tmp, "jgray", w, h, ["-grayscale"])
        make_jpeg(tmp, "jrgb", w, h, ["-rgb"])
        make_jpeg(tmp, "j420_rst", w, h, ["-restart", "1"])
        make_jpeg(tmp, "j444_rst3b", w, h, ["-sample", "1x1", "-restart", "3B"])
        make_jpeg(tmp, "j420_opt", w, h, ["-optimize", "-quality", "60"])
        make_jpeg(tmp, "j420_q100", w, h, ["-quality", "100"])
        make_jpeg(tmp, "jprog420", w, h, ["-progressive"])
        make_jpeg(tmp, "jprog444", w, h, ["-progressive", "-sample", "1x1"])
        make_jpeg(tmp, "jprog422", w, h, ["-progressive", "-sample", "2x1"])
        make_jpeg(tmp, "jproggray", w, h, ["-progressive", "-grayscale"])
        make_jpeg(tmp, "jprog_rst", w, h, ["-progressive", "-restart", "2B"])
        scans = os.path.join(tmp, "seq.scans")
        with open(scans, "w") as f:
            f.write("0;\n1;\n2;\n")
        make_jpeg(tmp, "jseq_scans", w, h, ["-scans", scans])
        make_jpeg(tmp, "j420_1x1", 1, 1, [])
        make_jpeg(tmp, "j420_2x2", 2, 2, [])
        make_jpeg(tmp, "j420_17x9", 17, 9, [])
        make_jpeg(tmp, "jmixed", 33, 21, ["-sample", "2x2,1x2,2x1"])
        make_jpeg(tmp, "jarith", w, h, ["-arithmetic"], bad=True)
        make_jpeg(tmp, "j12bit", w, h, ["-precision", "12"], bad=True)
        if shutil.which("sips"):
            make_sips_jpeg(tmp)
        if shutil.which("magick"):
            subprocess.run(["magick", os.path.join(tmp, "src.ppm"), "-colorspace", "CMYK",
                            os.path.join(DATA, "jcmyk.bad.jpg")], check=True)


def make_sips_jpeg(tmp):
    # A baseline file from Apple's encoder, decoded by djpeg for reference.
    w, h = 37, 29
    src = os.path.join(tmp, "sips.png")
    rgb = jpeg_source(w, h, 11)
    rows = [b"\x00" + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h)]
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")
    with open(src, "wb") as f:
        f.write(png)
    jpg = os.path.join(DATA, "jsips.jpg")
    subprocess.run(["sips", "-s", "format", "jpeg", src, "--out", jpg], check=True, capture_output=True)
    out = os.path.join(tmp, "out.pnm")
    subprocess.run(["djpeg", "-pnm", "-outfile", out, jpg], check=True)
    write("jsips.rgba", read_pnm(out)[2])


def make_big(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    w = h = 1024
    rnd = Lcg(3)
    raw = bytearray()
    for y in range(h):
        raw.append(4)
        prev = None
        for x in range(w):
            raw += bytes(((x * 3 + y) & 255, (y * 5 - x) & 255, (x ^ y) & 255, 255 - (rnd.next() & 15)))
    rows = [bytes(raw[y * (w * 4 + 1) + 1:(y + 1) * (w * 4 + 1)]) for y in range(h)]
    z = zlib.compress(filter_rows(rows, 4, 0), 6)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", z) + chunk(b"IEND", b"")
    open(os.path.join(out_dir, "big.png"), "wb").write(png)
    ppm = os.path.join(out_dir, "big.ppm")
    write_ppm(ppm, w, h, jpeg_source(w, h))
    subprocess.run(["cjpeg", "-quality", "90", "-outfile", os.path.join(out_dir, "big.jpg"), ppm], check=True)
    subprocess.run(["cjpeg", "-progressive", "-quality", "90", "-outfile", os.path.join(out_dir, "big_prog.jpg"), ppm], check=True)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--big":
        make_big(sys.argv[2])
        return
    os.makedirs(DATA, exist_ok=True)
    make_pngs()
    make_jpegs()


main()
