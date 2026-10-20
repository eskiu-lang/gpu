# gpu

GPU compute and rendering for [Eskiu](https://eskiu-lang.org), over WebGPU through
[wgpu-native](https://github.com/gfx-rs/wgpu-native). One API runs on Metal (macOS),
Vulkan (Linux) and DirectX 12 (Windows), with shaders written in WGSL.

```c
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

## Requirements

- wgpu-native 29 (`brew install wgpu-native` on macOS; on Linux and Windows, the
  [release archives](https://github.com/gfx-rs/wgpu-native/releases)).
- SDL3 for windows (`<gpu/window>` only): `brew install sdl3`, or your system's package.
- Eskiu 0.12 or newer.

## Using it

```bash
eskiuc add gpu --git https://github.com/eskiu-lang/gpu --rev v0.1.0
eskiuc build -L/opt/homebrew/lib          # the directory that holds libwgpu_native
```

On Linux the library must also be on the loader path at run time
(`LD_LIBRARY_PATH`, or install it next to the system libraries). On Windows,
`wgpu_native.dll` goes next to the executable.

## Modules

| Module | What it has |
|---|---|
| `<gpu>` | `<gpu/core>` and `<gpu/render>` together |
| `<gpu/core>` | `gpu_open`, `Gpu`, `GpuBuffer` (storage, read, write), `GpuKernel` (compute) |
| `<gpu/render>` | `GpuTexture`, `GpuSampler`, `GpuPipeline`, `GpuPass`, vertex, index and uniform buffers, window surfaces |
| `<gpu/window>` | `window_open`, `Window` input events and its `GpuSurface`, over SDL3 (links SDL3) |
| `<gpu/math>` | `Mat4` (perspective, look at, rotate, translate, multiply) |
| `<gpu/async>` | `Gpu_wait_async` and `GpuBuffer_read_async`, for code on the event loop |
| `<gpu/raw>` | the whole WebGPU C API (`webgpu.h` and `wgpu.h`), generated |

Every call that can fail returns a `Result`, with the message from WebGPU's validation
layer as its error (a WGSL syntax error comes with its line and column). Each object
has a `release()` for `defer`. `<gpu/raw>` covers what the idiomatic layer does not;
its handles are the same ones the `Gpu*` structs hold.

## Examples

`examples/compute.esk` adds two arrays of a million floats. `examples/triangle.esk` and
`examples/cube.esk` open a window (the cube is textured, with a depth buffer); pass
`--frames N` to quit after N frames.

```bash
eskiuc run -L/opt/homebrew/lib examples/cube.esk
```

## Development

```bash
eskiuc test -L/opt/homebrew/lib                                     # tests/*.esk
tools/gen.py $(brew --prefix wgpu-native)/include                   # regenerate src/raw.esk
tools/layout_check.sh $(brew --prefix wgpu-native)/include /opt/homebrew/lib
```

`tools/layout_check.sh` compiles a C program and an Eskiu program that print the size
and field offsets of every WebGPU struct, and compares them. CI runs it and the tests
on Linux (software Vulkan, no GPU) and macOS.

## License

MIT.
