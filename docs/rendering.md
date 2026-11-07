# Rendering

The rendering API of `<gpu/render>` (also in `<gpu>`), past the first triangle in the [README](../README.md#rendering). Every call that can fail returns a `Result` with the WebGPU validation message.

## Textures and samplers

Textures come from pixels or files. `<gpu/image>` decodes PNG and JPEG, and
`Gpu_image_with` stores them as sRGB (for color) with mipmaps; `Gpu_sampler_with` picks the
filtering, wrapping and anisotropy:

```eskiu
Bitmap img = image_load("albedo.jpg")?;
defer img.free();
GpuImageOptions o = GpuImageOptions{srgb: true, mipmaps: true};
GpuTexture tex = gpu.image_with(img.width, img.height, img.rgba, &o)?;
GpuSamplerOptions so = GpuSamplerOptions{mipmaps: true, anisotropy: 8, wrap_u: WGPUAddressMode_ClampToEdge};
GpuSampler samp = gpu.sampler_with(&so)?;
```

In a uniform or storage buffer a WGSL `vec3<f32>` takes 16 bytes, so a field the shader
reads as `vec3` is a `Vec4` (or a `Vec3` and a `float`) on the Eskiu side.

## Frames with several passes, bind groups, blending and depth

A game frame usually draws the scene, then the interface over it, and samples render targets
in later passes. A `GpuEncoder` records several passes and submits them once; each pass
clears or keeps (`load`) its color and depth:

```eskiu
GpuEncoder enc = gpu.encoder();
GpuPass scene = enc.pass(frame.view, GpuColor{0.1, 0.1, 0.1, 1.0}, &depth);
scene.set_group(0, &camera_group);
scene.set_group(1, &tiles_group);
scene.draw_range(&tiles, &tile_vertices, first, count, 0, 1);
scene.end()?;
GpuPassOptions over = GpuPassOptions{load: true};
GpuPass ui = enc.pass_with(frame.view, &over);
ui.set_scissor(x, y, w, h);
ui.draw(&panel, &panel_vertices, 6, 1);
ui.end()?;
enc.submit()?;   // the frame's errors come back here
surface.present(&frame);
```

`gpu.pass(...)` and `gpu.pass_with(view, &options)` are a pass with an encoder of its own,
submitted by `end()`.

A `GpuBindLayout` describes one `@group` and is shared by every pipeline that names it in
`GpuPipelineDesc.groups`; a `GpuBindGroup` made from it holds the resources and is set on
a pass by index. The WebGPU bind group is made the first time it is set and kept until one
of its bindings changes, so thousands of draws a frame create no bind groups:

```eskiu
GpuBindLayout cam = gpu.bind_layout();
cam.uniform(0, WGPUShaderStage_Vertex);
GpuBindLayout mat = gpu.bind_layout();
mat.texture(0, WGPUShaderStage_Fragment, WGPUTextureSampleType_Float);
mat.sampler(1, WGPUShaderStage_Fragment, WGPUSamplerBindingType_Filtering);
*GpuBindLayout[2] groups = {&cam, &mat};
GpuPipelineDesc d = GpuPipelineDesc{wgsl: shader, vertex: "vs", fragment: "fs", format: surface.format,
    layout: &vertex_layout, groups: &groups[0], group_count: 2,
    blend_mode: GPU_BLEND_ALPHA, depth: true, depth_format: WGPUTextureFormat_Depth32Float};
GpuPipeline sprites = gpu.pipeline(&d)?;
GpuBindGroup camera_group = cam.group()?;
camera_group.buffer(0, &camera_uniform);
```

A texture that is not filterable (`R32Float`, or one sampled only with nearest filtering)
takes `WGPUTextureSampleType_UnfilterableFloat` and a `WGPUSamplerBindingType_NonFiltering`
sampler. Bindings set with `pipe.bind()`, `bind_texture()` and `bind_sampler()` still work
for group 0 of a pipeline without `groups`.

The rest of `GpuPipelineDesc`:

| Field | Zero value | Other values |
|---|---|---|
| `blend_mode` | `GPU_BLEND_NONE` (`blend: true` is `GPU_BLEND_ALPHA`) | `GPU_BLEND_ALPHA`, `PREMULTIPLIED`, `ADDITIVE`, `MULTIPLY`, `CONSTANT` (mixes by the pass's `set_blend_constant`) |
| `blend_state` | null | any `*WGPUBlendState`, such as `SrcAlpha` plus `Constant` for a fade |
| `no_color_write` | colors written | `true` for a depth-only draw |
| `depth_format` | `Depth24Plus` | `Depth32Float` (make the texture with `gpu.texture(w, h, WGPUTextureFormat_Depth32Float, WGPUTextureUsage_RenderAttachment)`), `Depth24PlusStencil8`, `Depth32FloatStencil8` (when `gpu.depth32_stencil8`), `Stencil8` |
| `depth_compare` | `Less` | any `WGPUCompareFunction`, such as `Always` for overlays |
| `depth_read_only` | depth written | `true` turns depth writes off |
| `depth_bias`, `depth_bias_slope` | 0 | a depth offset |
| `layouts`, `layout_count` | the one `layout` | up to 8 vertex buffers, each a `GpuVertexLayout` with a `step` (`WGPUVertexStepMode_Instance` for per-instance data) and a first `location` |
| `stencil_front`, `stencil_back` | Always, Keep (back is front) | a `GpuStencilFace` |
| `stencil_read_mask`, `stencil_write_mask` | 0xFF | any 8-bit mask |
| `samples` | 1 | 4 (with `gpu.target_msaa` attachments) |
| `targets`, `target_count` | the one `format` | up to 8 `GpuColorTarget{format, blend_mode, blend_state, no_color_write}` (see below) |
| `fragment` | (required for color) | null for a depth-only pipeline with no color target (a shadow map) |

## Stencil and multisampling

A depth format with a stencil (`Depth24PlusStencil8` from `gpu.depth_stencil(w, h)`, available
everywhere; `Depth32FloatStencil8` when `gpu.depth32_stencil8`) gives each pixel an 8-bit
value that draws test and update. A pipeline's `stencil_front` and `stencil_back` are
`GpuStencilFace{compare, fail, depth_fail, pass}` (zero: Always and Keep; a zero
`stencil_back` is `stencil_front`), `stencil_read_mask`/`stencil_write_mask` are 0xFF when 0,
and the pass sets the reference with `set_stencil_reference`. The stencil needs `depth: true`;
a stencil-only draw sets `depth_compare: WGPUCompareFunction_Always, depth_read_only: true`,
and `no_color_write: true` draws into the stencil alone. Outlines, for instance:

```eskiu
GpuPipelineDesc d = GpuPipelineDesc{wgsl: shader, vertex: "vs", fragment: "fs", format: surface.format,
    depth: true, depth_format: WGPUTextureFormat_Depth24PlusStencil8,
    depth_compare: WGPUCompareFunction_Always, depth_read_only: true, no_color_write: true,
    stencil_front: GpuStencilFace{pass: WGPUStencilOperation_Replace}};
GpuPipeline mark = gpu.pipeline(&d)?;
d.no_color_write = false;
d.stencil_front = GpuStencilFace{compare: WGPUCompareFunction_NotEqual};
GpuPipeline outline = gpu.pipeline(&d)?;
// ...
pass.set_stencil_reference(3);
pass.draw(&mark, &object, n, 1);
pass.draw(&outline, &bigger_object, n, 1);
```

`GpuPassOptions` clears the stencil to `stencil_clear` (0 by default, `0xFF` for PICA-style
code) or keeps it with `stencil_load`.

For 4x antialiasing, draw into multisampled attachments and resolve into the frame:

```eskiu
GpuTexture color = gpu.target_msaa(w, h, surface.format, 4)?;
GpuTexture depth = gpu.target_msaa(w, h, WGPUTextureFormat_Depth24Plus, 4)?;
GpuPipelineDesc d = GpuPipelineDesc{..., depth: true, samples: 4};
// every frame
GpuPassOptions o = GpuPassOptions{clear: GpuColor{0.1, 0.1, 0.1, 1.0}, depth: &depth,
    resolve: frame.view, discard: true};
GpuPass pass = gpu.pass_with(color.view, &o);
```

Every pipeline in the pass needs the attachments' sample count (`end()` returns an `Err`
otherwise). `discard` drops the multisampled pixels once resolved, which saves memory traffic
on phones. A multisampled texture cannot be sampled or read back: read the resolve target.

## Several render targets

A pipeline with `targets` writes `@location(0)` to `@location(7)` of its fragment shader into
as many color targets, each with its own format and blending (at most 32 bytes per pixel in
all, so four RGBA16Float targets fit). The pass lists its attachments in
`GpuPassOptions.colors`, each with its own clear, `load`, `resolve` and `discard`, and takes a
null target:

```eskiu
GpuColorTarget[3] targets = {GpuColorTarget{format: WGPUTextureFormat_RGBA16Float},
    GpuColorTarget{format: WGPUTextureFormat_RGBA16Float, blend_mode: GPU_BLEND_ADDITIVE},
    GpuColorTarget{format: WGPUTextureFormat_R32Float}};
GpuPipelineDesc d = GpuPipelineDesc{wgsl: shader, vertex: "vs", fragment: "fs", layout: &l,
    targets: &targets[0], target_count: 3, depth: true};
GpuPipeline scene = gpu.pipeline(&d)?;
GpuColorAttachment[3] colors = {GpuColorAttachment{view: color.view}, GpuColorAttachment{view: bloom.view},
    GpuColorAttachment{view: mask.view, clear: GpuColor{1.0, 0.0, 0.0, 0.0}}};
GpuPassOptions o = GpuPassOptions{colors: &colors[0], color_count: 3, depth: &depth};
GpuPass pass = gpu.pass_with(null, &o);
```

A pipeline whose targets differ from the pass's attachments (in number, order or format) makes
`end()` (or the encoder's `submit()`) return an `Err` naming both lists; more than 8 targets or
attachments are an `Err` too.

## Layers, cube maps and mip levels

`gpu.texture_with(&desc)` makes any 2D texture: `GpuTextureDesc` has the size, `format`
(RGBA8Unorm when 0), `layers` (a 2D array; `array: true` for one with a single layer),
`cube` (six square faces, +X, -X, +Y, -Y, +Z, -Z; a multiple of six layers is a cube array),
`mips` or `mipmaps` (the full chain), `usage` (by default sampled, copyable and, for formats
that can be, a render target), `samples` and `view_formats`. The texture's `view` covers all of
it, so it binds as a `texture_2d_array` or `texture_cube`, and `GpuBindLayout_texture` takes
the view dimension after the sample type:

```eskiu
GpuTextureDesc env_desc = GpuTextureDesc{width: 256, height: 256, format: WGPUTextureFormat_RGBA16Float,
    cube: true, mipmaps: true};
GpuTexture env = gpu.texture_with(&env_desc)?;
for (face in 0..6) {
    GpuTextureView v = env.view_level(face, 0)?;   // a 2D render target of one face, level 0
    GpuPass pass = gpu.pass(v.view, GpuColor{0.0, 0.0, 0.0, 1.0}, null);
    // ...draw the sky seen through this face
    pass.end()?;
    v.release();
}
env.generate_mips()?;
layout.texture(0, WGPUShaderStage_Fragment, WGPUTextureSampleType_Float, WGPUTextureViewDimension_Cube);
```

`view_level(layer, mip)` is one layer (or face) and one mip level; `view_with(&GpuViewDesc)`
picks any range of levels and layers, a dimension, a format and an aspect; a `GpuTextureView`
binds with `group.view(binding, &v)` (or `pipe.bind_view`) and renders through `v.view`.
`write_level(layer, mip, data)` uploads one level of one layer and `read_level(layer, mip, out)`
reads one back.

`generate_mips()` fills levels 1 and up of every layer from level 0 on the GPU (WebGPU has no
mipmap call: it is a render pass per level with a small built-in shader), each texel the
average of the 2x2 texels under it, in linear light for sRGB formats. It works on any
renderable float or normalized format (RGBA8, BGRA8, their sRGB forms, RGBA16Float,
RGBA32Float...) of a texture with render-target and sampled usage, so it can follow
rendering, such as an environment cube drawn each frame. `Gpu_image_with`'s `mipmaps` still
filters on the CPU.

## Shadow maps

A depth texture can be sampled: `gpu.depth_texture(w, h, format, layers)` (Depth32Float when
`format` is 0) is a render attachment that binds as `texture_depth_2d`, or
`texture_depth_2d_array` with several layers, with sample type `WGPUTextureSampleType_Depth`.
A pipeline with a null `fragment` writes only depth, in a pass with a null target and
`GpuPassOptions.depth` (or `depth_view`, one layer of an array). A sampler with
`GpuSamplerOptions.compare` set (bound as `WGPUSamplerBindingType_Comparison`) makes
`textureSampleCompare` return 1 where the comparison passes and 0 elsewhere, and with linear
filtering the fraction of the 2x2 texels that pass (percentage-closer filtering):

```eskiu
GpuTexture shadows = gpu.depth_texture(1024, 1024, 0, 4)?;   // four lights
GpuPipelineDesc sd = GpuPipelineDesc{wgsl: caster, vertex: "vs", fragment: null, layout: &l,
    depth: true, depth_format: WGPUTextureFormat_Depth32Float, depth_bias: 2, depth_bias_slope: 2.0};
GpuTextureView light0 = shadows.view_level(0, 0)?;
GpuPassOptions o = GpuPassOptions{depth_view: &light0};
GpuPass pass = gpu.pass_with(null, &o);
// ...draw the casters from the light
GpuSamplerOptions so = GpuSamplerOptions{wrap_u: WGPUAddressMode_ClampToEdge, wrap_v: WGPUAddressMode_ClampToEdge,
    compare: WGPUCompareFunction_LessEqual};
layout.texture(2, WGPUShaderStage_Fragment, WGPUTextureSampleType_Depth, WGPUTextureViewDimension_2DArray);
layout.sampler(3, WGPUShaderStage_Fragment, WGPUSamplerBindingType_Comparison);
```

## Compressed textures, KTX2 and HDR images

`gpu_open` turns on what the adapter offers and says so in `Gpu`: `bc` (BC1 to BC7, on
desktop GPUs and Apple Silicon Macs), `etc2` and `astc` (ETC2/EAC and ASTC, on phones and Apple
Silicon), and `float32_filterable` (linear filtering of R32Float, RG32Float and RGBA32Float).
A texture in a compressed format comes from `texture_with` (its size a multiple of the block
size) and `write_level`, whose data is rows of blocks; a level smaller than a block still
takes one whole block. Making one without the device feature is an `Err`.

`<gpu/ktx2>` reads KTX 2.0 files (`ktx2_load`, `ktx2_decode`): 2D textures, arrays and cube
maps with their mip levels, in the BC, ETC2/EAC and ASTC formats and the uncompressed ones
WebGPU samples (RGBA8 and sRGB, BGRA8, R8, RG8, the 16- and 32-bit floats, RGB10A2,
RG11B10 and RGB9E5). `gpu.ktx2(&file)` uploads it; a file that asks for its mip levels to be
made gets them from `generate_mips`. Basis Universal data (ETC1S or UASTC, which need
transcoding) and zstd or zlib supercompression are not supported: such files return an `Err`.

```eskiu
Ktx2 k = ktx2_load("ground.ktx2")?;
defer k.free();
GpuTexture ground = gpu.ktx2(&k)?;
```

`<gpu/image>` also decodes Radiance `.hdr` files (`hdr_load`, `hdr_decode`, flat or
run-length encoded RGBE) to an `HdrBitmap` of RGBA floats; `to_half` converts it for an
RGBA16Float texture (`image_f16` converts one value):

```eskiu
HdrBitmap sky = hdr_load("sky.hdr")?;
defer sky.free();
*uint16 half = alloc<uint16>((int)(sky.width * sky.height * 4));
sky.to_half(half);
GpuTextureDesc d = GpuTextureDesc{width: sky.width, height: sky.height, format: WGPUTextureFormat_RGBA16Float};
GpuTexture env = gpu.texture_with(&d)?;
env.write_level(0, 0, half)?;
```

## sRGB and linear views

A texture made with `view_formats` (the sRGB or linear twin of its format, from
`gpu_srgb_format` and `gpu_linear_format`) can be seen through either: `view_as(format)` gives
the other view. Through an sRGB view, sampling converts to linear light and drawing converts
back; through the linear one the bytes are taken as they are. A surface does the same with
`surface.configure_with(w, h, gpu_srgb_format(surface.format))`: each `GpuFrame` then has
`alt_view` besides `view`, so a frame can draw a scene in sRGB and an interface in linear
values. (Metal supports surface view formats; Vulkan needs `VK_KHR_swapchain_mutable_format`.)

## Instances, ranges, viewport and scissor

Per-instance data goes in a second vertex buffer, set with `pass.set_vertices(1, &instances)`;
`pass.draw_range(&pipe, &vertices, first, count, first_instance, instances)` draws part of a
buffer. `pass.set_viewport(x, y, w, h)` and `pass.set_scissor(x, y, w, h)` take pixels from
the top left.

`texture.write_region(x, y, w, h, pixels)` updates part of a texture, such as one glyph of
an atlas. Targets from `gpu.target` (RGBA8) or `gpu.target_with` (another format) can be
sampled by a later pass. `target.read(pixels)` waits for the GPU; `target.read_async()`
returns a `GpuReadback` that a later frame takes without stalling:

```eskiu
GpuReadback rb = target.read_async()?;   // after the frame's submit
// ...a later frame:
if (rb.ready()) {
    rb.take(pixels)?;
    rb.release();
}
```

For skinning in your own shader, `gpu.joints(&gltf, skin)` (from `<gpu/model>`) is a storage
buffer of a skin's joint matrices (`array<mat4x4<f32>>`, joint j at byte j * 64) and
`gpu.joints_uniform(&gltf, skin, capacity)` a uniform buffer of `capacity` matrices;
`joints.update(&gltf)` refreshes them from the current pose (after `gltf.animate`). Bind
`joints.buffer` like any buffer.

[`tests/render_api.esk`](tests/render_api.esk) draws each of these into a small image and
compares it with `tests/data/render_*.rgba`; [`tests/render_targets.esk`](tests/render_targets.esk)
covers several targets, layers, cube maps, mip levels and shadow maps, and
[`tests/texture_formats.esk`](tests/texture_formats.esk) KTX2, compressed formats and `.hdr`
files, from fixtures it writes itself.

**Upgrading from 0.3.** The bind group that `pipe.bind()`, `bind_texture()` and
`bind_sampler()` make now belongs to the pipeline: it is made at the first draw after a
binding changes and reused by later draws and passes, where 0.3 made one per draw and
released them at the end of the pass. Two things follow. A buffer or texture bound to a
pipeline stays alive (on the GPU) until it is replaced by another `bind` call or the
pipeline is released. And after releasing a bound resource and making a new one, call
`bind` again: a draw without it uses the old resource instead of failing. `pass.end()` and
`enc.submit()` now return a pass's validation errors without submitting the invalid
commands, which wgpu-native answered by aborting the program.
