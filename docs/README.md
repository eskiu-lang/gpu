# gpu documentation

Guides and reference for gpu. The [README](../README.md) has the overview.

<!-- pages -->
- [Image-based lighting](ibl.md)
- [Image decoding options](image.md)
- [Machine learning](ml.md)
- [iOS and Android](mobile.md)
- [Models](models.md)
- [Morph targets](morph.md)
- [Rendering](rendering.md)
- [Model shadows](shadows.md)
- [In a browser](web.md)
- [API reference](api.md): every public function and type
<!-- /pages -->

## Platforms

| Modules | macOS arm64 | Linux x86-64 | Windows x86-64 | iOS (arm64, simulator) | Android (arm64, x86-64) | WebAssembly |
|---|---|---|---|---|---|---|
| WebGPU: `<gpu>`, `<gpu/core>`, `<gpu/render>`, `<gpu/model>`, `<gpu/nn>`, `<gpu/train>`, `<gpu/raw>` | yes (Metal) | yes (Vulkan) | yes (DirectX 12, Vulkan) | yes (Metal) | yes (Vulkan) | yes (the browser's WebGPU) |
| `<gpu/window>` (SDL3 desktop windows) | yes | yes | yes | no (use `<gpu/ui>`) | no (use `<gpu/ui>`) | yes (the page's canvas) |
| `<gpu/ui>` (`GpuView` for `eskiu-lang/ui`) | — | — | — | yes (`CAMetalLayer`) | yes (`SurfaceView`) | — |
| `<gpu/math>`, `<gpu/touch>`, `<gpu/image>`, `<gpu/ktx2>`, `<gpu/png>`, `<gpu/jpeg>`, `<gpu/gltf>`, `<gpu/obj>`, `<gpu/gguf>`, `<gpu/safetensors>` | yes | yes | yes | yes | yes | yes |

On iOS and Android, an app renders either into a `<gpu/ui>` `GpuView` (`use_gpu_surface` +
`gpu_ui_surface(&gpu)`) or directly into a `CAMetalLayer` (`gpu.surface_metal(layer)`) or
`ANativeWindow*` (`gpu.surface_android(window)`). In a browser, WebGPU is the browser's own,
through Emscripten's `emdawnwebgpu`: the build flags are in [docs/web.md](web.md).

A game in an eskiu-ui app (the surface's life cycle, one draw per display frame, several
fingers at once) is in [docs/mobile.md](mobile.md).

## Modules

| Module | What it has |
|---|---|
| `<gpu>` | `<gpu/core>` and `<gpu/render>` together |
| `<gpu/core>` | `gpu_open`, `Gpu`, `GpuBuffer` (storage, read, write) and `GpuKernel` (compute) |
| `<gpu/render>` | `GpuTexture` (`Gpu_texture_with`: layers, cube maps, mip levels, view formats; `generate_mips`), `GpuTextureView`, `GpuSampler`, `GpuPipeline`, `GpuPass`, `GpuEncoder`, `GpuBindLayout`, `GpuBindGroup`, `GpuReadback`, vertex, index and uniform buffers, window, mobile and canvas surfaces (`surface_metal`, `surface_android`, `surface_x11`, `surface_wayland`, `surface_win32`, `surface_canvas`) |
| `<gpu/window>` | `window_open`, `Window` input events and its `GpuSurface`, over SDL3 on desktop (links SDL3) |
| `<gpu/ui>` | `GpuView`, `use_gpu_surface`, `gpu_ui_surface`, `use_gpu_touch` and `use_gpu_touches` for `eskiu-lang/ui` apps on iOS and Android |
| `<gpu/touch>` | `GpuTouch`, `GpuTouches` (the fingers that are down) and the `"gpu"` channel's touch payload |
| `<gpu/image>` | `image_load`, `image_decode`: PNG and JPEG to RGBA8; `hdr_load`, `hdr_decode`: Radiance `.hdr` to floats (`HdrBitmap`) |
| `<gpu/ktx2>` | `ktx2_load`, `ktx2_decode`: KTX2 files (compressed and uncompressed, arrays, cube maps, mip levels; no Basis supercompression), uploaded by `Gpu_ktx2` |
| `<gpu/gltf>` | `gltf_load`, `Gltf` (meshes, materials, textures, nodes, skins, animations), `animate`, `world`, `bounds` |
| `<gpu/obj>` | `obj_load`, `obj_parse`: OBJ and MTL into a `Gltf` |
| `<gpu/ibl>` | `Gpu_ibl`, `GpuIbl`: environment, irradiance and prefiltered specular cubes and the BRDF table from an HDR image; `Gpu_brdf_lut` |
| `<gpu/model>` | `model_load`, `Gpu_model`, `GpuModel` (`update`, `draw`, `camera`), `GpuCamera`, `GpuLight`, `GpuJoints` (joint matrices for your own skinning shader) |
| `<gpu/math>` | `Vec2`, `Vec3`, `Vec4` and `Quat` with arithmetic operators, `Mat4` (perspective, ortho, look at, translate, rotate, scale, `mat4_trs`), slerp |
| `<gpu/nn>` | `NnTensor` (f32, f16, Q8_0, Q4_0), `NnProgram` with matvec, RMSNorm, RoPE, attention, SwiGLU, argmax |
| `<gpu/train>` | `NnGraph`: inputs, parameters, matmul, bias, ReLU, tanh, cross entropy, MSE, `backward`, Adam, SGD |
| `<gpu/gguf>` | `gguf_load`, metadata, tensors, dequantization of F32, F16, BF16, Q4_0 to Q8_0 and Q2_K to Q6_K |
| `<gpu/safetensors>` | `safetensors_load`, `SafeTensor_floats`, `SafetensorsWriter` |
| `<gpu/async>` | `Gpu_wait_async` and `GpuBuffer_read_async` for code on the event loop |
| `<gpu/raw>` | the WebGPU C API, generated from `webgpu.h` and `wgpu.h` |

Each object has a `release()` to pair with `defer`. The handles inside the `Gpu*` structs are
the `<gpu/raw>` ones, so a program can drop down to the C API for anything the idiomatic
layer does not cover.

Every public function and type, with its documentation, is in the [API reference](api.md).

## Contributing

Bug reports are welcome; please include the program, the `eskiuc --version` output and the
adapter it ran on. The tests and the layout check run with:

```bash
eskiuc test
tools/gen.py $(brew --prefix wgpu-native)/include            # regenerates src/raw.esk
python3 -I tools/gen_test_models.py                          # regenerates the glTF test models
tools/layout_check.sh $(brew --prefix wgpu-native)/include /opt/homebrew/lib
```

`tools/layout_check.sh` compiles a C program and an Eskiu program that print the size and
field offsets of every WebGPU struct and compares their output. CI runs it and the tests on
Linux (software Vulkan, no GPU needed) and macOS.

## Installation details

The package's `eskiu.toml` names wgpu-native 29's own release archives for macOS (arm64 and
x86-64), Linux (x86-64 and arm64), Windows x86-64, iOS (arm64 device, arm64 simulator and
x86-64 simulator) and Android (arm64 and x86-64): the first build that links it
(`eskiuc build`, `run`, `test`, or a `--target` cross-build) downloads the one for the
target platform, checks its SHA-256 and keeps it in `~/.eskiu/native`, and every build links
against it with no `-L` (on Windows the DLL is copied next to the program; `ui build ios`
and `ui build android` link `libwgpu_native.a` into the app bundle). A program that only
uses the pure Eskiu modules downloads nothing.

`<gpu/window>` also needs SDL3, which publishes no prebuilt library for macOS or Linux: install
it from your system (`brew install sdl3` on macOS, the SDL3 development package or
[libsdl.org](https://libsdl.org) elsewhere) and give its directory to a build that opens a
window, as in `eskiuc build -L/opt/homebrew/lib`.
