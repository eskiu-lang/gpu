# Changelog

All notable changes to this package are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
