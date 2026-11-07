# Image decoding options

`<gpu/image>` decodes PNG and JPEG to RGBA8 (`Bitmap`). `image_decode` and `image_load` keep the
pixels as stored and reject images of more than `IMAGE_MAX_PIXELS` pixels; the `_with`
variants take `ImageOptions` to change the limit and to turn photos upright by their EXIF
orientation. Texture uploads are in [rendering.md](rendering.md#textures-and-samplers).

```eskiu
ImageOptions o = ImageOptions{orient: true, max_pixels: 64 * 1024 * 1024};
Bitmap photo = image_load_with("IMG_0042.jpg", &o)?;   // upright, at most 64 Mpixel
defer photo.free();
```

## ImageOptions

The zero value is what `image_decode` does.

| Field | Meaning |
|---|---|
| `max_pixels` | Images with more pixels (width times height) are rejected with "image too large" from their header, before the pixels are allocated. 0 is `IMAGE_MAX_PIXELS`. |
| `orient` | Turn a JPEG upright by its EXIF orientation (`Bitmap_orient`), so the bitmap shows what a photo viewer shows. Without it the pixels stay as stored and `image_orientation` says how to show them. PNG files are never rotated. |

`const int64 IMAGE_MAX_PIXELS = 0x10000000` (268,435,456 pixels, 1 GiB of RGBA8): the default
limit of both decoders, the same one they applied before it was configurable.

## Functions

- `Result<Bitmap, string> image_decode_with(*uint8 data, uint64 len, *ImageOptions o)` and
  `Result<Bitmap, string> image_load_with(string path, *ImageOptions o)`: `image_decode` and
  `image_load` with options (`o` may be null).
- `Result<Bitmap, string> jpeg_decode_with(*uint8 data, uint64 len, *ImageOptions o)` and
  `Result<Bitmap, string> png_decode_with(*uint8 data, uint64 len, *ImageOptions o)`: the same
  for one format.
- `int image_orientation(*uint8 data, uint64 len)` and `int jpeg_orientation(*uint8 data,
  uint64 len)`: the EXIF orientation of an encoded image, 1 to 8, without decoding it; 1 when
  it has none, for a PNG, or when the EXIF data is malformed.
- `void Bitmap_orient(*Bitmap self, int orientation)`: rearranges a bitmap's pixels by an
  orientation so it is upright. Values outside 2 to 8 do nothing.

## EXIF orientation

The orientation is TIFF tag 0x0112 (a SHORT) in IFD0 of the first APP1 `Exif` segment before
the first scan, in either byte order (`II` little-endian or `MM` big-endian). Other APP1
segments (XMP) and EXIF data that points outside its segment are ignored.

| Value | Stored image | `Bitmap_orient` does | Size |
|---|---|---|---|
| 1 | upright | nothing | same |
| 2 | mirrored | mirrors left and right | same |
| 3 | upside down | turns half a turn | same |
| 4 | flipped | flips top and bottom | same |
| 5 | transposed | transposes (mirror, then a quarter turn counterclockwise) | swapped |
| 6 | turned a quarter counterclockwise | turns a quarter clockwise | swapped |
| 7 | transversed | transverses (mirror, then a quarter turn clockwise) | swapped |
| 8 | turned a quarter clockwise | turns a quarter counterclockwise | swapped |

Phones usually write 6 for portrait photos: the sensor stores a landscape image, and with
`orient` the bitmap comes out portrait (width and height swapped).
