# Morph targets

glTF morph targets (blend shapes) in `<gpu/gltf>` and `<gpu/model>`. The short example is in the [README](../README.md#models).

API reference: [`<gpu/gltf>`](api.md#gpugltf), [`<gpu/model>`](api.md#gpumodel).

```eskiu
Gltf data = gltf_load("face.glb")?;
GpuModel model = gpu.model(&data, surface.format)?;

// every frame: an animation's "weights" channels, or your own values
data.animate(0, seconds);
model.update(mat4_identity());
float[2] smile = {0.8, 0.1};
model.set_weights(node, &smile[0], 2);   // sent at once, no update() needed
```

## What the loader reads

Each primitive's `targets` (the `POSITION`, `NORMAL` and `TANGENT` deltas of each target,
sparse accessors included), the mesh's default `weights`, each node's `weights`, and
animation channels whose path is `weights`.

| Field | Meaning |
|---|---|
| `GltfPrimitive.target_count` | Number of morph targets of the primitive (0 for none). |
| `GltfPrimitive.target_positions` | `target_count * vertex_count * 3` floats: the position delta of target `t` for vertex `v` is at `(t * vertex_count + v) * 3`. Null when no target has `POSITION`. |
| `GltfPrimitive.target_normals` | The same for `NORMAL` deltas, or null. |
| `GltfPrimitive.target_tangents` | The same for `TANGENT` deltas (xyz; the handedness is not morphed), or null. |
| `GltfMesh.weights` | The mesh's default weights, one per target; zero for those the file leaves out. |
| `GltfNode.weights` | The node's current weights, one per target of its mesh: the node's own `weights` when the file has them, else a copy of the mesh's. `Gltf_animate` and `Gltf_set_weights` change them; `<gpu/model>` reads them. |
| `GltfAnimSampler.value_count` | Number of output values of the sampler. A `weights` sampler's values are scalars, `target_count` of them per key (three times that for `CUBICSPLINE`: in-tangents, values, out-tangents). |

A target that lacks an attribute other targets have gets zero deltas for it.

## Functions

- `Gltf_animate(*Gltf self, int anim, float t)` now also samples `GLTF_WEIGHTS` channels
  (step, linear and cubic spline, like the other paths) into the target node's `weights`.
  A channel whose output does not hold one value per target for each key is skipped.
- `void Gltf_set_weights(*Gltf self, int node, *float weights, int count)` sets a node's
  weights from `weights[0..count)`; values past the node's target count are ignored, and
  weights not given keep their value.
- `void GpuModel_set_weights(*GpuModel self, int node, *float weights, int count)` does the
  same on the model's `Gltf` and uploads the node's weights to the GPU right away (no
  `update()` needed). `update()` uploads every node's weights too.

## On the GPU

`Gpu_model` uploads each primitive's deltas to a storage buffer (three `vec4<f32>` per target
and vertex: position, normal, tangent), and each drawn node keeps a storage buffer of its
weights. The vertex shader adds `delta * weight` for every target whose weight is not 0,
indexed by `@builtin(vertex_index)`, before skinning (as glTF orders them), so morphed and
skinned meshes work together; shadow map passes apply the same deformation. The cost is 48
bytes per target and vertex of GPU memory, and a loop over the targets for each vertex.

Caveats:

- Like skinning, this needs storage buffers in the vertex stage.
- One primitive's deltas must fit the device's `maxStorageBufferBindingSize` (128 MiB by
  default): `target_count * vertex_count * 48` bytes.
- `Gltf_bounds` and `GpuModel_camera` use the undeformed positions.
