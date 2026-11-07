# In a browser

The WebGPU modules also build for `wasm32-unknown-emscripten`. In a browser the GPU is the
browser's own WebGPU, reached through Emscripten's `emdawnwebgpu` port, and the same Eskiu
program builds for the desktop and for the web: `examples/triangle.esk`, `cube.esk` and
`model.esk` run in a page unchanged. The platform table is in the [docs index](README.md#platforms).

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
--link-arg=-sJSPI or --link-arg=-sASYNCIFY)", and a browser without WebGPU (or node) gives
"no WebGPU in this browser".

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

## Tested

In headless Chrome 157 (Metal on Apple Silicon, `--enable-unsafe-webgpu`): the triangle, the
cube and the model viewer (DamagedHelmet) draw at 60 frames per second, and the package's
tests pass except `raw_compute` (it calls `wgpuDevicePoll`) and `safetensors` (it writes a
file into `build/`). CI builds the examples for the web (and the compute one with Asyncify
too), runs the layout check against emdawnwebgpu's header, and runs the compute example
under node, which has no WebGPU.

## Regenerating the bindings

`tools/gen.py --web DIR` rewrites the Emscripten section of `src/raw.esk` from emdawnwebgpu's
`webgpu/webgpu.h` (Emscripten downloads it into emsdk's
`upstream/emscripten/cache/ports/emdawnwebgpu/emdawnwebgpu_pkg/webgpu/include` on the first
build with `--use-port=emdawnwebgpu`), and `tools/layout_check.sh --web` compares its struct
layouts with `emcc`'s.
