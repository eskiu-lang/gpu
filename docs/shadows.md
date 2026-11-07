# Model shadows

Shadows from `GpuModel.light` in `<gpu/model>`: one directional light, a shadow map rendered
from it through an orthographic projection, read back with a comparison sampler and
percentage-closer filtering. They are off by default, and a model without them draws
exactly as before. The short example is in the [README](../README.md#models); the
lower-level pieces (depth textures, comparison samplers, depth-only pipelines) are in
[rendering.md](rendering.md#shadow-maps).

API reference: [`<gpu/model>`](api.md#gpumodel).

```eskiu
GpuShadowOptions so = GpuShadowOptions{size: 2048};
model.enable_shadows(&so)?;            // null for the defaults

// every frame, after update() and before the pass that draws the model
model.update(mat4_identity());
model.render_shadows()?;
GpuPass pass = gpu.pass(frame.view, clear, &depth);
model.draw(&pass, &cam);
pass.end()?;
```

## API

- `Result<int, string> GpuModel_enable_shadows(*GpuModel self, *GpuShadowOptions o)` makes the
  shadow map (Depth32Float) and the depth-only pipeline and turns shadows on. Calling it again
  replaces them with the new options.
- `void GpuModel_disable_shadows(*GpuModel self)` releases them and turns shadows off.
- `Result<int, string> GpuModel_render_shadows(*GpuModel self)` renders the shadow map from the
  light in a submission of its own. Call it each frame after `update()` (and after changing
  `model.light`) and before `draw()`. Nothing happens when shadows are off.
- `Result<int, string> GpuModel_render_shadows_in(*GpuModel self, *GpuEncoder enc)` records the
  same pass into `enc`, ahead of the pass that draws the model in the same submission.

Until `render_shadows` has run once, `draw()` lights the model as if shadows were off.

### GpuShadowOptions

Each field's zero value picks the default.

| Field | Default | Meaning |
|---|---|---|
| `size` | 2048 | Width and height of the shadow map in texels. |
| `bias` | 0.002 | Subtracted from a point's depth from the light before the test, in the light box's depth units (0 at its near side, 1 at its far side). Raise it for shadow acne, lower it if shadows detach from their casters. |
| `normal_bias` | 1.5 | How far each point moves along its surface normal before the test, in shadow map texels. |
| `slope_bias` | 1.0 | Depth bias slope scale of the shadow pipeline (more bias on surfaces steep to the light). |
| `radius` | fit | Half-size of the cube the light sees. 0 fits the model's bounds (with its transform) at each `render_shadows`. |
| `center` | | Center of that cube when `radius` is set. |

### GpuModel fields

| Field | Meaning |
|---|---|
| `shadows` | Whether shadows are on. |
| `shadow` | The options in use, with the defaults filled in. |
| `shadow_map` | The Depth32Float shadow map (sampled as `texture_depth_2d`). |
| `shadow_pipeline` | The depth-only pipeline that renders it. |
| `shadow_sampler` | The comparison sampler (LessEqual, linear, clamped). |
| `light_view_proj` | The light's view and orthographic projection from the last `render_shadows`. |

## How it works

The light looks along `light.direction` at the center of the box from twice its radius away,
with an orthographic projection of the box. Opaque and masked parts cast shadows (a mask casts
as if opaque); blended parts do not. Morph targets and skinning deform the casters as they do
the drawn model. The fragment shader moves the point along its geometric normal by
`normal_bias`, projects it into the map and averages 9 comparisons on a 3x3 texel grid; each
comparison is itself a 2x2 bilinear one (the linear comparison sampler), so the edge is soft
over about two texels. Points outside the light's box are lit. Only the directional light's
term is shadowed; the ambient (hemisphere or image-based) is not.
