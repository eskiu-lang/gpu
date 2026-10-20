<p align="center">
  <img src="https://raw.githubusercontent.com/eskiu-lang/eskiu/main/assets/logo.png" alt="Eskiu, a kitten with a ball of yarn" width="140">
</p>

<h2 align="center">gpu</h2>
<p align="center">GPU compute and rendering for Eskiu, over WebGPU.</p>
<p align="center"><sub>Part of the <a href="https://github.com/eskiu-lang">Eskiu</a> project</sub></p>
<p align="center">
  <a href="https://eskiu-lang.org">eskiu-lang.org</a> &nbsp;&middot;&nbsp;
  <a href="#modules">Modules</a> &nbsp;&middot;&nbsp;
  <a href="examples/">Examples</a> &nbsp;&middot;&nbsp;
  <a href="https://github.com/eskiu-lang/eskiu">The language</a>
</p>

<p align="center">
  <a href="https://github.com/eskiu-lang/gpu/actions/workflows/ci.yml"><img src="https://github.com/eskiu-lang/gpu/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-0.1.0-6448d4" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/wgpu--native-29-orange" alt="wgpu-native 29">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
</p>

---

`gpu` is an Eskiu package for running compute kernels and drawing on the GPU. It is built
on [wgpu-native](https://github.com/gfx-rs/wgpu-native), so one API runs on Metal (macOS),
Vulkan (Linux) and DirectX 12 (Windows), and shaders are written in WGSL.

- **Compute.** Storage buffers, kernels and dispatches, with results read back into
  Eskiu memory.
- **Rendering.** Textures, samplers, depth buffers, vertex, index and uniform buffers,
  render pipelines and passes, to an offscreen texture or a window.
- **Windows and input.** `<gpu/window>` opens a window over SDL3 and gives its surface
  and its keyboard and mouse events.
- **Errors as `Result`.** Every call that can fail returns one, with the message from the
  WebGPU validation layer; a WGSL error comes with its line and column.
- **The whole API underneath.** `<gpu/raw>` is all of `webgpu.h` and `wgpu.h`, generated,
  with every struct's layout checked against the C compiler.

<p align="center">
  <img src="assets/cube.png" alt="A textured cube rendered offscreen by tests/render_cube.esk" width="256">
</p>

## Compute

```eskiu
import <io>;
import <gpu>;

string twice = "@group(0) @binding(0) var<storage, read_write> v: array<f32>;\n"
    "@compute @workgroup_size(64)\n"
    "fn main(@builtin(global_invocation_id) id: vec3<u32>) { v[id.x] = v[id.x] * 2.0; }\n";

Result<int, string> run() {
    float[256] data;
    for (i in 0..256) data[i] = (float)i;
    Gpu gpu = gpu_open()?;
    defer gpu.release();
    GpuBuffer v = gpu.storage(&data, sizeof(data))?;
    defer v.release();
    GpuKernel k = gpu.kernel(twice, "main")?;
    defer k.release();
    k.bind(0, &v);
    k.dispatch(4, 1, 1)?;
    v.read(&data, sizeof(data))?;
    printf("%.1f\n", (double)data[255]);
    return Ok<int, string>(0);
}

Result<int, string> r = run();
if (!r.ok) printf("error: %s\n", r.error);
```

```
$ eskiuc run -L/opt/homebrew/lib twice.esk
510.0
```

## Rendering

A window, a pipeline and one draw per frame (from [`examples/triangle.esk`](examples/triangle.esk)):

```eskiu
Gpu gpu = gpu_open()?;
defer gpu.release();
Window win = window_open("Eskiu triangle", 800, 600)?;
defer win.release();
GpuSurface surface = win.surface(&gpu)?;
defer surface.release();
GpuPipelineDesc d = GpuPipelineDesc{wgsl: shader, vertex: "vs", fragment: "fs", format: surface.format};
GpuPipeline pipe = gpu.pipeline(&d)?;
defer pipe.release();

bool running = true;
WindowEvent ev;
while (running) {
    while (win.poll(&ev)) {
        if (ev.kind == WINDOW_QUIT) running = false;
        if (ev.kind == WINDOW_RESIZE) surface.configure(ev.width, ev.height);
    }
    GpuFrame frame = surface.frame()?;
    GpuPass pass = gpu.pass(frame.view, GpuColor{0.08, 0.08, 0.1, 1.0}, null);
    pass.draw(&pipe, null, 3, 1);
    pass.end()?;
    surface.present(&frame);
}
```

[`examples/cube.esk`](examples/cube.esk) adds a vertex and an index buffer, a texture, a
depth buffer and a matrix uniform built with `<gpu/math>`:

```eskiu
Quat spin = quat_axis_angle(Vec3{0.4, 1.0, 0.2}, t);
Mat4 mvp = proj * view * mat4_trs(position, spin, Vec3{1.0, 1.0, 1.0});
ub.write(0, &mvp, sizeof(Mat4));
```

In a uniform or storage buffer a WGSL `vec3<f32>` takes 16 bytes, so a field the shader
reads as `vec3` is a `Vec4` (or a `Vec3` and a `float`) on the Eskiu side. Both quit with Escape, or after N frames
with `--frames N`.

## Install

The package needs wgpu-native 29, and SDL3 for `<gpu/window>`:

```bash
brew install wgpu-native sdl3          # macOS
```

On Linux and Windows, wgpu-native comes from its
[release archives](https://github.com/gfx-rs/wgpu-native/releases) and SDL3 from your system's
packages or [libsdl.org](https://libsdl.org). Then, in an Eskiu package (Eskiu 0.12 or newer):

```bash
eskiuc add gpu --git https://github.com/eskiu-lang/gpu --rev v0.1.0
eskiuc build -L/opt/homebrew/lib       # the directory that holds libwgpu_native
```

On Linux the library also has to be on the loader path when the program runs
(`LD_LIBRARY_PATH`, or a system library directory). On Windows, `wgpu_native.dll` goes next
to the executable.

## Modules

| Module | What it has |
|---|---|
| `<gpu>` | `<gpu/core>` and `<gpu/render>` together |
| `<gpu/core>` | `gpu_open`, `Gpu`, `GpuBuffer` (storage, read, write) and `GpuKernel` (compute) |
| `<gpu/render>` | `GpuTexture`, `GpuSampler`, `GpuPipeline`, `GpuPass`, vertex, index and uniform buffers, window surfaces |
| `<gpu/window>` | `window_open`, `Window` input events and its `GpuSurface`, over SDL3 (links SDL3) |
| `<gpu/math>` | `Vec2`, `Vec3`, `Vec4` and `Quat` with arithmetic operators, `Mat4` (perspective, ortho, look at, translate, rotate, scale, `mat4_trs`), slerp |
| `<gpu/async>` | `Gpu_wait_async` and `GpuBuffer_read_async` for code on the event loop |
| `<gpu/raw>` | the WebGPU C API, generated from `webgpu.h` and `wgpu.h` |

Each object has a `release()` to pair with `defer`. The handles inside the `Gpu*` structs are
the `<gpu/raw>` ones, so a program can drop down to the C API for anything the idiomatic
layer does not cover.

## Contributing

Bug reports are welcome; please include the program, the `eskiuc --version` output and the
adapter it ran on. The tests and the layout check run with:

```bash
eskiuc test -L/opt/homebrew/lib
tools/gen.py $(brew --prefix wgpu-native)/include            # regenerates src/raw.esk
tools/layout_check.sh $(brew --prefix wgpu-native)/include /opt/homebrew/lib
```

`tools/layout_check.sh` compiles a C program and an Eskiu program that print the size and
field offsets of every WebGPU struct and compares their output. CI runs it and the tests on
Linux (software Vulkan, no GPU needed) and macOS.

## License

MIT. See [LICENSE](LICENSE).
