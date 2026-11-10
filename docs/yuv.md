# Camera and video frames

Cameras and video decoders give pictures as YUV: a full-size plane of brightness (Y) and
two smaller planes of color (U and V, also called Cb and Cr), often with padding at the end
of each row. `<gpu/yuv>` puts those planes on the GPU as they are and turns them into RGB
in a shader, so a live camera or a playing video can be drawn, or fed to a model, without
a conversion pass on the CPU.

API reference: [`<gpu/yuv>`](api.md#gpuyuv).

```eskiu
import <gpu>;
import <gpu/yuv>;

Gpu gpu;
GpuSurface surface;
GpuYuv yuv;        // from gpu.yuv(surface.format), once

// Called with each new frame: (*GpuYuvImage)frame for a CameraFrame from
// use_camera_frames (eskiu-lang/ui-camera) or a VideoFrame from use_video_frames
// (eskiu-lang/video).
Result<int, string> show(*GpuYuvImage frame) {
    yuv.upload(frame)?;
    GpuFrame f = surface.frame()?;
    GpuPass pass = gpu.pass(f.view, GpuColor{0.0, 0.0, 0.0, 1.0}, null);
    GpuYuvDraw d = GpuYuvDraw{width: (float)surface.width, height: (float)surface.height,
                              fit: GPU_YUV_COVER, mirror: frame.front};
    yuv.draw(&pass, &d);
    pass.end()?;
    surface.present(&f);
    return Ok<int, string>(0);
}
```

## Frames

`GpuYuvImage` describes one frame: its size, its layout (`format`), up to three planes, how
far to turn it to be upright (`rotation`), and how its YUV maps to RGB (`matrix` and
`full_range`). It has the field layout of `CameraFrame` from
[eskiu-lang/ui-camera](https://github.com/eskiu-lang/ui-camera) and `VideoFrame` from
[eskiu-lang/video](https://github.com/eskiu-lang/video), with the same format and matrix
numbers, so a pointer to either is cast to a `*GpuYuvImage` and uploaded with no copy;
`tests/yuv.esk` checks the layout. Any other source fills one by hand.

| `format` | Planes | Uploaded as |
|---|---|---|
| `GPU_YUV_NV12` | Y, then U and V interleaved (U first) | Y in an `R8Unorm` texture, UV in an `RG8Unorm` texture of half the size |
| `GPU_YUV_NV21` | Y, then V and U interleaved | the same, with the two chroma channels swapped in the shader |
| `GPU_YUV_I420` | Y, U, V | three `R8Unorm` textures |
| `GPU_YUV_420` | Y, U, V with chroma samples `pixel_stride` bytes apart (Android's `YUV_420_888`) | `RG8Unorm` or `RGBA8Unorm` textures whose first channel is the sample, or `R8Unorm` after a repack |
| `GPU_YUV_RGBA` | one RGBA plane (a browser's video) | an `RGBA8Unorm` texture, drawn as it is |

Chroma planes are half the width and height, rounded up. Each plane's `row_stride` (the
bytes from one row to the next) goes to the GPU as the upload's bytes per row, so padded
rows are uploaded without a copy. A plane is repacked on the CPU, into a buffer the `GpuYuv`
keeps, only when no texture format reads it in place: samples 3 or more than 4 bytes apart,
or a plane whose last row ends before the texture's last texel would (the second byte of the
last pair of a `pixel_stride` 2 plane). `upload` checks the description first
(`gpu_yuv_check`): a plane that is missing or too short for its rows, a stride under the
row's bytes, an unknown format or a rotation other than 0, 90, 180 and 270 is an `Err`, so
nothing reads outside a plane.

The planes are read while `upload` runs, so a frame borrowed from the camera or a video
player can be given back as soon as it returns. The textures are made again only when the
frame's size or layout changes.

## Color

The shader computes, with the planes' values from 0 to 255:

```
Y' = (Y - 16) * 255 / 219            limited range (full range: Y' = Y)
Cb = (U - 128) * 255 / 224           limited range (full range: U - 128)
Cr = (V - 128) * 255 / 224
R = Y' + 2 (1 - Kr) Cr
G = Y' - 2 Kb (1 - Kb) / Kg Cb - 2 Kr (1 - Kr) / Kg Cr
B = Y' + 2 (1 - Kb) Cb
```

with Kr 0.299 and Kb 0.114 for BT.601, Kr 0.2126 and Kb 0.0722 for BT.709, and Kg = 1 - Kr -
Kb, clamped to 0 to 255. These are the formulas `CameraFrame_to_rgba` uses on the CPU, so
the GPU's result matches it within one step (the step a GPU's rounding to 8 bits may
differ by). Phone cameras give full-range BT.601; HD video is usually limited-range BT.709.

The result is the picture's own (gamma-encoded) values. Drawing into an sRGB target
(`RGBA8UnormSrgb`, `BGRA8UnormSrgb`) decodes them to linear light first, so the target's
encoding stores the same bytes.

## Drawing

`Gpu_yuv(gpu, target_format)` makes a `GpuYuv` for targets of one format (a surface's, or
`RGBA8Unorm` when 0). `GpuYuv_draw(pass, &d)` draws the last uploaded frame into a pass on such
a target, in the rectangle `x`, `y`, `width`, `height` of `GpuYuvDraw` (pixels from the top
left, inside the target). The pass may have a depth attachment: the picture then passes every
depth test and writes no depth, so a camera background drawn first stays under the 3D scene
drawn after it in the same pass.

| `fit` | What it does |
|---|---|
| `GPU_YUV_STRETCH` | fills the rectangle, whatever the picture's aspect ratio |
| `GPU_YUV_CONTAIN` | the whole picture at its aspect ratio, centered; the rest of the rectangle keeps what the pass has |
| `GPU_YUV_COVER` | fills the rectangle at the picture's aspect ratio, cropping what overflows about the center |

- **Rotation.** With `upright` (the default) the picture is turned clockwise by the frame's
  `rotation`, so it shows the way the screen is held; `upright: false` draws it as the
  sensor or the file stores it. `GpuYuv_out_width` and `out_height` give the size after
  turning.
- **Mirror.** `mirror` flips it left to right after turning, the way a front camera's
  preview is usually shown (`mirror: frame.front`).
- **Filtering.** The planes are sampled with linear filtering, chroma included (it is
  upsampled smoothly). `nearest` takes the texel under each pixel instead.

`draw` sets the pass's viewport to the rectangle it fills, and the viewport stays for the
draws that follow. Its placement goes into a uniform buffer through the queue, so a
`GpuYuv` draws once per submission: two pictures on screen are two `GpuYuv`s.

## To a texture

`GpuYuv_to_rgba(upright)` renders the frame into an `RGBA8Unorm` texture the `GpuYuv` keeps
(`yuv.rgba`), one texel per pixel, turned upright when asked, and returns a pointer to it. It
is a texture like any other: sample it in your own shader, hand it to `<gpu/model>`, run a
compute kernel over a copy, or read it back with `GpuTexture_read`. It uses no filtering:
each pixel takes its own Y and the chroma sample that covers it, as the CPU conversion does.
The texture is made again when the size changes, so take the pointer after each call, and
release the `GpuYuv`, not the texture.

## Tests

`tests/yuv.esk` builds a 7 x 5 frame (odd, so the chroma planes round up) in every layout:
NV12 with padded rows, NV21, I420, three planes with chroma 2 bytes apart and the last
partner byte missing (repacked), 3 bytes apart (repacked) and RGBA; with each matrix and
range, and each rotation turned upright. It reads the result of `to_rgba` back and compares
every channel with the formulas above in doubles, allowing one step, then checks `draw`'s
fits, mirror and rectangle and an sRGB target. It runs in CI on lavapipe (software Vulkan) and
on Metal, and passes in Chrome's WebGPU too (built for `wasm32-unknown-emscripten`).
