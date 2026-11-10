# Models

`<gpu/gltf>`, `<gpu/obj>` and `<gpu/model>`: loading glTF 2.0 and OBJ files and drawing them. The first example is [below](#loading-and-drawing-a-model).

## Loading and drawing a model

```eskiu
Gltf data = model_load("helmet.glb")?;   // or a .gltf, or an .obj
defer data.free();
GpuModel model = gpu.model(&data, surface.format)?;
defer model.release();

// every frame
data.animate(0, seconds);
model.update(mat4_identity());
GpuCamera cam = model.camera(aspect);
GpuPass pass = gpu.pass(frame.view, GpuColor{0.1, 0.1, 0.1, 1.0}, &depth);
model.draw(&pass, &cam);
pass.end()?;
```

glTF (`.gltf`, `.glb`) and OBJ files load into the same `Gltf`, and `GpuModel` draws them with
metallic-roughness shading, normal maps, skinning and animation.
[`examples/model.esk`](../examples/model.esk) is a viewer. What the loaders read, the
materials and the lighting are in [docs/models.md](models.md).

Morph targets follow the glTF weights, from animations or `model.set_weights`
([docs/morph.md](morph.md)). Image-based lighting from an HDR environment
([docs/ibl.md](ibl.md)) and shadow maps from the light ([docs/shadows.md](shadows.md))
are opt-in:

```eskiu
GpuIbl ibl = gpu.ibl(&sky, null)?;      // sky = hdr_load("sky.hdr")?
model.set_ibl(&ibl);
model.enable_shadows(null)?;            // then each frame, before the pass: model.render_shadows()?;
```

API reference: [`<gpu/gltf>`](api.md#gpugltf), [`<gpu/obj>`](api.md#gpuobj), [`<gpu/model>`](api.md#gpumodel).

The loader reads meshes (every attribute type, sparse accessors, strips and fans), PBR
materials with their textures and samplers, the node hierarchy, skins and animations
(linear, step and cubic spline), from `.glb` files or `.gltf` files with external or
embedded buffers. `KHR_mesh_quantization`, `KHR_materials_unlit`,
`KHR_materials_emissive_strength`, `KHR_texture_transform` (offset, rotation and scale per
texture, and its `texCoord`), `KHR_node_visibility` (a hidden node hides its descendants) and
`KHR_animation_pointer` are supported. An animation pointer can drive a node's translation,
rotation, scale, weights and visibility, and a material's base color, emissive, metallic,
roughness and alpha cutoff factors and each texture's offset, rotation and scale; other
pointers are skipped. `GpuModel_update` writes a material again when an animation changed it
(`Gltf.material_version`). The renderer shades with glTF's
metallic-roughness model under one directional light (`model.light`) and a hemisphere
ambient term. [`examples/model.esk`](examples/model.esk) is a viewer for glTF and OBJ files: drag to orbit, scroll
to zoom, space pauses the animation.

OBJ files load into the same `Gltf` (`obj_load`, or `model_load` for either kind). Each
object becomes a mesh, polygons are triangulated, and the MTL is mapped to the same
materials: `Kd`/`map_Kd` base color, `d`/`Tr` alpha, `Ke`/`map_Ke` emission,
`bump`/`map_Bump`/`norm` normal map (with `-bm`), `Ns` (or `Pr`/`Pm`) roughness and
metallic, `illum 0` unlit, and `-clamp on`. Vertex colors (`v x y z r g b`) are kept.

Morph targets are in [morph.md](morph.md), image-based lighting in [ibl.md](ibl.md) and
shadows in [shadows.md](shadows.md). Not supported yet: Draco and meshopt compression, and
KTX2 textures.
