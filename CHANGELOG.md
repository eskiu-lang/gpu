# Changelog

All notable changes to this package are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.0] - 2026-11-07

### Added

- Stencil in `<gpu/render>`: `GpuStencilFace` and `GpuPipelineDesc.stencil_front`,
  `stencil_back`, `stencil_read_mask`, `stencil_write_mask`; `GpuPassOptions.stencil_clear`
  and `stencil_load`; `GpuPass_set_stencil_reference`; `Gpu_depth_stencil`
  (Depth24PlusStencil8), and Depth32FloatStencil8 when the device has it
  (`Gpu.depth32_stencil8`). Passes set stencil ops only for formats with a stencil.
- Multisampling: `GpuPipelineDesc.samples`, `Gpu_target_msaa` for color and depth
  attachments, `GpuTexture.samples`, and `GpuPassOptions.resolve` and `discard`.
- Multitouch on the mobile `GpuView` (`<gpu/ui>`): `use_gpu_touch(fn(GpuTouch))` gets each
  finger's down, move, up and cancel with a stable id and its position in the view's pixels;
  `use_gpu_touches()` keeps the fingers that are down (`GpuTouches`) for a `use_frame`
  handler to read. Android sends every pointer of a `MotionEvent`, iOS enables
  `multipleTouchEnabled`. Controls over the view keep their own touches.
- `<gpu/touch>`: `GpuTouch`, `GpuTouches` and the touch payload parser, without `<ui>`.
- Several render targets: `GpuColorTarget` and `GpuPipelineDesc.targets`/`target_count` (a
  format and blending per target, up to 8); `GpuColorAttachment` and
  `GpuPassOptions.colors`/`color_count` (clear, load, resolve and discard per attachment). A
  pipeline that disagrees with the pass's attachments is an `Err` from `end()` or `submit()`.
- Layered textures: `GpuTextureDesc` and `Gpu_texture_with` (2D arrays, cube maps and cube
  arrays, mip levels, usage, view formats); `GpuTexture.layers`, `dimension` and `usage`;
  `GpuTextureView` from `GpuTexture_view_level` (one layer or face and mip level, to render
  into), `view_with` (`GpuViewDesc`) and `view_as`; `GpuBindGroup_view` and
  `GpuPipeline_bind_view`; `GpuTexture_write_level` and `read_level`; `gpu_mip_count`.
  `GpuBindLayout_texture` takes an optional view dimension (2D, 2DArray, Cube).
- `GpuTexture_generate_mips`: mip levels made on the GPU (a render pass per level and layer,
  box filter, linear light for sRGB) for 2D, array and cube textures in renderable float and
  normalized formats.
- Shadow maps: `GpuSamplerOptions.compare` (comparison samplers, PCF with linear filtering),
  `Gpu_depth_texture` (sampled as `texture_depth_2d` or `texture_depth_2d_array`),
  depth-only pipelines (a null `GpuPipelineDesc.fragment`), passes with no color attachment
  (a null target), and `GpuPassOptions.depth_view` for one layer of a depth array.
- Device features: `gpu_open` turns on `float32-filterable`, `texture-compression-bc`, `-etc2`
  and `-astc` when the adapter has them (`Gpu.float32_filterable`, `bc`, `etc2`, `astc`);
  block-compressed textures are made with `Gpu_texture_with` and filled with `write_level`.
- `<gpu/ktx2>`: `ktx2_load`, `ktx2_decode` and `Ktx2` (2D, array and cube KTX2 files with mip
  levels, BC, ETC2/EAC, ASTC and uncompressed formats; Basis Universal and supercompressed
  files are rejected), uploaded by `Gpu_ktx2`; `gpu_vk_format`.
- Radiance `.hdr` decoding in `<gpu/image>`: `hdr_load`, `hdr_decode`, `HdrBitmap`
  (`to_half` for RGBA16Float) and `image_f16`.
- sRGB and linear views: `gpu_srgb_format`, `gpu_linear_format`, texture `view_formats` with
  `view_as`, and `GpuSurface_configure_with` (a surface view format) with `GpuFrame.alt_view`.

### Fixed

- Reading back a texture that cannot be copied (such as a multisampled one) returns an `Err`
  instead of aborting in wgpu-native.

## [0.4.0]

### Added

- `<gpu/render>`: `GpuBindLayout` (`Gpu_bind_layout`, `uniform`, `storage`, `texture` with a
  sample type, `sampler` with a binding type such as `NonFiltering`, `group`) and
  `GpuBindGroup` (`buffer`, `texture`, `sampler`), listed per `@group` in
  `GpuPipelineDesc.groups` and set with `GpuPass_set_group(index, &group)`. A group is made on
  first use and kept until a binding changes.
- `GpuEncoder` (`Gpu_encoder`, `pass`, `pass_with`, `submit`): several passes in one command
  encoder and one submission per frame.
- `GpuPassOptions` and `Gpu_pass_with`: clear or load per attachment (color and depth).
- `GpuPipelineDesc` fields: `blend_mode` (`GpuBlend`: `GPU_BLEND_NONE`, `ALPHA`,
  `PREMULTIPLIED`, `ADDITIVE`, `MULTIPLY`, `CONSTANT`), `blend_state` (any `WGPUBlendState`),
  `no_color_write`, `depth_format` (`Depth24Plus` or `Depth32Float`), `depth_compare`,
  `depth_bias`, `depth_bias_slope`, and `layouts`/`layout_count` for up to 8 vertex buffers.
- `GpuVertexLayout.step` (per-vertex or per-instance) and `GpuVertexLayout.location` (the
  first shader location of its attributes).
- `GpuPass_set_vertices`, `GpuPass_draw_range` (first vertex and first instance),
  `GpuPass_set_scissor`, `GpuPass_set_viewport`, `GpuPass_set_blend_constant`.
- `GpuTexture_write_region` for sub-rectangle updates and `Gpu_target_with` for render targets
  in other formats.
- `GpuTexture_read_async` and `GpuReadback` (`ready`, `take`, `release`): a texture readback
  that does not block the frame.
- `<gpu/model>`: `GpuJoints` (`Gpu_joints`, `Gpu_joints_uniform`, `update`, `release`), a
  skin's joint matrices in a storage or uniform buffer for skinning in user shaders.
- `tests/render_api.esk` with golden images in `tests/data/render_*.rgba`.

### Changed

- The bind group made from `GpuPipeline_bind`, `bind_texture` and `bind_sampler` belongs to
  the pipeline and is reused until a binding changes, instead of one per draw released at the
  end of the pass. Resources bound to a pipeline stay alive until they are rebound or the
  pipeline is released; after replacing a bound resource, call `bind` again (a draw without it
  uses the old resource instead of failing).
- `GpuPass_end` checks the pass for validation errors before submitting, and returns them
  without submitting the invalid commands (wgpu-native aborted the program on those).
- `GpuTexture_read` copies the texel size of the texture's format instead of 4 bytes.
