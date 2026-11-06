# Changelog

All notable changes to this package are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
