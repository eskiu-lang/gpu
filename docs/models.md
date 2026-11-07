# Models

`<gpu/gltf>`, `<gpu/obj>` and `<gpu/model>`: loading glTF 2.0 and OBJ files and drawing them. The short example is in the [README](../README.md#models).

The loader reads meshes (every attribute type, sparse accessors, strips and fans), PBR
materials with their textures and samplers, the node hierarchy, skins and animations
(linear, step and cubic spline), from `.glb` files or `.gltf` files with external or
embedded buffers. `KHR_mesh_quantization`, `KHR_materials_unlit` and
`KHR_materials_emissive_strength` are supported. The renderer shades with glTF's
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
