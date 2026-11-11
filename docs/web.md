# In a browser

The WebGPU modules also build for `wasm32-unknown-emscripten`. In a browser the GPU is the
browser's own WebGPU, reached through Emscripten's `emdawnwebgpu` port, and the same Eskiu
program builds for the desktop and for the web: `examples/triangle.esk`, `cube.esk` and
`model.esk` run in a page unchanged. A browser without WebGPU (Firefox, Safari before 26,
WebKitGTK in a Tauri app on Linux) gets the [WebGL2 backend](#webgl2) for rendering, with no
change to the program. The platform table is in the [docs index](README.md#platforms).

API reference: [`Gpu_surface_canvas`](api.md#gpu_surface_canvas), [`<gpu/window>`](api.md#gpuwindow).

## Building

Eskiu 0.14 or newer and Emscripten 4.0.10 or newer (`emcc` on `PATH`; CI uses 5.0.2):

```bash
eskiuc examples/triangle.esk --target wasm32-unknown-emscripten -o triangle.html \
    --link-arg=--use-port=emdawnwebgpu --link-arg=-sJSPI
python3 -m http.server     # then open http://localhost:8000/triangle.html
```

`--use-port=emdawnwebgpu` links the browser's WebGPU, and `-sJSPI` (or `-sASYNCIFY`, below)
lets the program wait for the GPU. An `.html` output is Emscripten's default page, with a
canvas whose id is `canvas`; a `.js` output is for your own page. WebGPU needs a secure
context, so serve the files over `https` or from `localhost`. A program that loads models or
large textures also wants `--link-arg=-sALLOW_MEMORY_GROWTH=1`, and its files go into the
page's file system with `--link-arg=--preload-file=helmet.glb`.

In a package that depends on `gpu`, the same flags go to `eskiuc build` (the output directory
must exist):

```bash
mkdir -p build
eskiuc build --target wasm32-unknown-emscripten -o build/app.html \
    --link-arg=--use-port=emdawnwebgpu --link-arg=-sJSPI
```

## Waiting for the GPU

A browser never blocks on the GPU: it answers with promises. The `gpu` API stays
synchronous, because each call that waits (`gpu_open`, a validation scope after creating a
pipeline or ending a pass, `read`, `Gpu_wait`, `GpuSurface_present`) suspends the program
until the browser's promise settles and then continues where it was. Suspending needs one of
two Emscripten modes:

| Flag | Browsers | Cost |
|---|---|---|
| `-sJSPI` | those with WebAssembly JavaScript Promise Integration (Chrome and Edge 137 and newer) | none in size or speed |
| `-sASYNCIFY` | every browser with WebGPU | about twice the `.wasm` size, and slower calls |

A build with neither fails in `gpu_open` with "no WebGPU instance (build with
--link-arg=-sJSPI or --link-arg=-sASYNCIFY)", and a page with neither WebGPU nor WebGL2 (or
node) gives "no WebGPU in this browser". The browsers that need the WebGL2 backend mostly
lack JSPI too, so a page meant for them is built with `-sASYNCIFY`.

Under JSPI a wait cannot happen inside a `try` body or in a function called from one:
Emscripten runs those calls through JavaScript, which JSPI cannot suspend, and the page
stops with "trying to suspend JS frames". Keep GPU work outside `try`, or build that program
with `-sASYNCIFY`, which handles it.

`<gpu/async>` works too: while it waits it also lets the browser run.

## Windows and canvases

`<gpu/window>` maps to the page in a browser. `window_open(title, width, height)` sets the
page title and gives the canvas with id `canvas` a CSS size of width x height (0 x 0 keeps
the size the page's own CSS gives it), with a backing store of that size times the device
pixel ratio; `Window_surface` draws into it. Keys, mouse buttons, motion and the wheel come
from the page as `WindowEvent`s, a WINDOW_RESIZE comes when the canvas's size in pixels
changes, and WINDOW_QUIT never comes: a program ends when its loop does.

`GpuSurface_present` cannot hand the frame to the browser directly. It releases the frame and
suspends the program until the browser's next animation frame, when the canvas shows what
was drawn, so a `while` frame loop runs at the display's rate.

Any other canvas works with `Gpu_surface_canvas`, which takes a CSS selector and configures
the surface to the canvas's size in pixels:

```eskiu
Gpu gpu = gpu_open()?;
defer gpu.release();
#ifdef __EMSCRIPTEN__
GpuSurface surface = gpu.surface_canvas("#view")?;
#else
GpuSurface surface = win.surface(&gpu)?;
#endif
defer surface.release();
```

## What differs

- `<gpu/raw>` is generated from emdawnwebgpu's `webgpu.h` for the web, so wgpu-native's
  extras (`wgpuDevicePoll`, the `WGPUNative*` names) are not there, and Emscripten's
  `WGPUEmscriptenSurfaceSourceCanvasHTMLSelector` is. `size_t` fields are `uint32`.
- Limits and optional features (f16, subgroups, compressed formats) are what the browser
  offers. A shader of yours that uses subgroup operations needs `enable subgroups;` in a
  browser; `<gpu/nn>` adds it to its own.
- `GpuPass_end` and `GpuEncoder_submit` submit the work before checking it, since the
  canvas's texture expires at the next display refresh. An invalid pass is still an `Err`;
  the browser also reports it in the console.
- `GpuReadback_ready` lets the browser run for a moment when the pixels have not arrived.
- `<gpu/window>` needs no SDL3, and the surface functions for native windows
  (`surface_metal`, `surface_x11` and the others) return an `Err`.
- Without WebGPU, rendering runs on [WebGL2](#webgl2) and compute is not available.

## Tested

In headless Chrome 157 (Metal on Apple Silicon, `--enable-unsafe-webgpu`): the triangle, the
cube and the model viewer (DamagedHelmet) draw at 60 frames per second, and the package's
tests pass except `raw_compute` (it calls `wgpuDevicePoll`) and `safetensors` (it writes a
file into `build/`).

On the WebGL2 backend, in headless Brave 1.99 (Chromium 157) with WebGPU off, on ANGLE over
Metal and on SwiftShader, with JSPI and with Asyncify: the render, texture, model, morph,
IBL, OBJ and YUV tests pass (`render_targets` skips its two-sampler shadow case and its sRGB
views), their golden images within one unit per channel, and the scenes of
`render_scenes.esk`, DamagedHelmet and an 81-joint skinned model among them, are the same
bytes as on the browser's WebGPU on the same GPU. CI builds the examples for the web (and the compute one with Asyncify
too), runs the layout check against emdawnwebgpu's header, and runs the compute example
under node, which has no WebGPU.

## WebGL2

`gpu_open` asks the browser's WebGPU for an adapter first. When the page has no
`navigator.gpu`, or it gives no adapter (a GPU the browser blocks), the device is the WebGL2
backend instead and `Gpu.webgl2` is true. The same `<gpu/render>` calls, WGSL shaders and
`<gpu/model>` code run on it, and they give the same pixels: on one GPU the scenes of
`tools/render_scenes.esk` match the browser's WebGPU byte for byte.

The backend needs one more file next to the page: `web/gpu-naga.wasm` from this package
(about 820 KB), which turns WGSL into GLSL ES 3.00. It is fetched only when the backend is
used, from `gpu-naga.wasm` beside the page unless the page sets another place before the
program's script. With Eskiu 0.15.1 or newer, a web build of an app that depends on gpu
copies it beside the output (`build/app.html` gets `build/gpu-naga.wasm`), from the
package's `[web] assets`; with an older compiler, copy it by hand. To serve it elsewhere:

```html
<script>
  var Module = {
    gpuNagaUrl: "/static/gpu-naga.wasm",   // or gpuNagaWasm: an ArrayBuffer already loaded
    gpuBackend: "",                        // "webgl2" skips WebGPU; "webgpu" turns WebGL2 off
  };
</script>
```

Without the file, `gpu_open` fails with "no GPU adapter: WebGL2: cannot load gpu-naga.wasm"
and the reason. `tools/naga_wasm.sh` builds it from `tools/naga-wasm`, a small Rust crate over
naga (the WGSL translator of wgpu). naga's MIT license and those of the crates built into the
module are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

### How it works

The backend is the part of the WebGPU JavaScript API that `<gpu/render>` uses, written over
WebGL2 (`web/webgl2.js`; `gpu_open` evaluates it in the page, so no build flag adds it):
emdawnwebgpu calls it as it would call the browser's WebGPU. At pipeline creation each entry
point becomes GLSL, naga reports which uniform block and sampler stands for each
`@group`/`@binding`, and at each draw the bind groups set on the pass fill those uniform
buffer slots and texture units. Commands run at submit, after the writes queued before it,
as on WebGPU. A surface frame is a texture of the backend's; once the program lets the
browser run, it is copied into the canvas through a 2D context.

### What it does not have

Each of these is an `Err` (the validation message) where WebGPU would succeed:

- Compute and storage: `Gpu_kernel`, `<gpu/nn>`, `<gpu/train>`, storage buffers and storage
  textures. Skinning in your own shader takes `Gpu_joints_uniform`. `GpuModel` switches by
  itself to a uniform array of joints (up to 256 per skin) and morph targets in a texture (up
  to 256 per primitive).
- WGSL that GLSL ES 3.00 cannot express: one texture sampled through two different samplers
  in a shader, `textureNumLevels`, `reverseBits` and the other bit-field built-ins, `f16`,
  subgroups.
- Views in another format: `view_formats`, `GpuTexture_view_as` and
  `GpuSurface_configure_with`.
- Sampling a 2D view of one layer of an array or cube texture (each layer is still a render
  target), and cube arrays. A texture of 6 square layers is a cube unless its first view is
  a 2D array (`GpuTextureDesc.array`).
- Reading back depth, stencil, compressed and snorm textures.
- Vertex strides above 255 bytes; uniform blocks above `maxUniformBufferBindingSize` (16 KB on
  most devices); `drawIndexed` with a base vertex; query sets, timestamps, render bundles and
  indirect draws from `<gpu/raw>`.
- Float render targets need the browser's `EXT_color_buffer_float`, blending into 32-bit
  floats `EXT_float_blend`, and different blending per color target `OES_draw_buffers_indexed`
  (each widely available).

`GpuTexture_generate_mips` makes the same 2x2 box filter as on WebGPU. A frame costs one copy
more than on WebGPU, from the backend's WebGL2 canvas into the page's.

### Testing a page without WebGPU

`tools/web_run.mjs` runs a program built for the web in headless Chrome, Chromium or Brave
(`CHROME` names the binary) and exits with its exit code. `--no-webgpu` starts the browser
with WebGPU off and removes `navigator.gpu`, as in Firefox; `--null-adapter` keeps
`navigator.gpu` with no adapter; `--gpu webgl2` forces the backend; `--swiftshader` renders
on the CPU, as a CI runner does. Build with `-sEXIT_RUNTIME=1` so the exit code reaches it:

```bash
eskiuc tests/render_api.esk --target wasm32-unknown-emscripten -o build/web/render_api.js \
    --link-arg=--use-port=emdawnwebgpu --link-arg=-sJSPI --link-arg=-sEXIT_RUNTIME=1 \
    --link-arg=-sALLOW_MEMORY_GROWTH=1 --link-arg=--preload-file=tests/data@tests/data
node tools/web_run.mjs build/web/render_api.js --no-webgpu
```

`tools/render_scenes.esk` prints a triangle, a textured cube, instancing with scissor and
viewport, a stencil mask, two render targets, render to texture with mipmaps and the glTF
test models (skinned and textured) as pixels; `tools/compare_scenes.py` compares those of
two runs (native, the browser's WebGPU, WebGL2).

## Regenerating the bindings

`tools/gen.py --web DIR` rewrites the Emscripten section of `src/raw.esk` from emdawnwebgpu's
`webgpu/webgpu.h` (Emscripten downloads it into emsdk's
`upstream/emscripten/cache/ports/emdawnwebgpu/emdawnwebgpu_pkg/webgpu/include` on the first
build with `--use-port=emdawnwebgpu`), and `tools/layout_check.sh --web` compares its struct
layouts with `emcc`'s.
