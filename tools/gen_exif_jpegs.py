#!/usr/bin/env python3
# Writes tests/data/exif_base.jpg (32x16, quadrants red, green, blue and
# white, 4:4:4, no EXIF) and tests/data/exif_6.jpg (the same with EXIF
# orientation 6, as Pillow writes it: a big-endian TIFF). tests/image_exif.esk
# builds the other orientations and the little-endian variants itself.
# Needs Pillow:  python3 tools/gen_exif_jpegs.py tests/data
import sys
from PIL import Image
out = sys.argv[1]
im = Image.new("RGB", (32, 16))
cols = {(0,0):(255,0,0),(1,0):(0,255,0),(0,1):(0,0,255),(1,1):(255,255,255)}
for y in range(16):
    for x in range(32):
        im.putpixel((x,y), cols[(x//16, y//8)])
im.save(out + "/exif_base.jpg", quality=95, subsampling=0)
ex = Image.Exif()
ex[0x0112] = 6
im.save(out + "/exif_6.jpg", quality=95, subsampling=0, exif=ex.tobytes())
