# Image-based lighting

`<gpu/ibl>` lights physically based materials with an environment map, and `<gpu/model>`
uses it in place of its hemisphere ambient term. A model is loaded as in
[Models](models.md#loading-and-drawing-a-model).

API reference: [`<gpu/ibl>`](api.md#gpuibl), [`<gpu/hdr>`](api.md#gpuhdr).

```eskiu
import <gpu/ibl>;

HdrBitmap sky = hdr_load("sky.hdr")?;      // equirectangular, linear light
defer sky.free();
GpuIbl ibl = gpu.ibl(&sky, null)?;          // null: the default sizes
defer ibl.release();
model.set_ibl(&ibl);                        // ibl must outlive its use
ibl.intensity = 0.8;
```

`Gpu_ibl` makes four textures, all on the GPU with one render pass per cube face and mip level
(no compute shaders, so it runs wherever rendering does, Lavapipe and WARP included):

1. **environment**: the equirectangular image resampled into a cube map, with its full mip
   chain (`GpuTexture_generate_mips`).
2. **irradiance**: for each direction `n`, the cosine-weighted average radiance over the
   hemisphere around `n` (64 x 16 samples, weights normalized). This is the irradiance divided
   by pi, so a Lambertian surface of albedo `c` reflects `irradiance * c`, and a constant
   environment gives back its own value.
3. **specular**: the environment prefiltered with the GGX distribution for one roughness per
   mip level, `roughness = level / (mips - 1)` (level 0 is the environment itself). It uses
   Hammersley points, importance sampling with `N = V = R` (Karis), and reads the environment
   mip level that matches each sample's solid angle, which keeps the result smooth with few
   samples.
4. **brdf**: the split-sum table, RG16Float. Texel `(x, y)` is NdotV `(x + 0.5) / size` and
   roughness `(y + 0.5) / size`; red is the scale and green the bias of F0, with GGX and
   Smith-Schlick visibility (`k = roughness^2 / 2`).

## API

`Result<GpuIbl, string> Gpu_ibl(*Gpu self, *HdrBitmap equirect, *GpuIblOptions o)` makes the
textures from an image `hdr_load` or `hdr_decode` returned (it is uploaded as RGBA16Float and
freed from the GPU afterwards). `o` may be null.

`Result<GpuIbl, string> Gpu_ibl_texture(*Gpu self, *GpuTexture equirect, *GpuIblOptions o)`
does the same from an equirectangular texture already on the GPU: a filterable 2D texture
(RGBA16Float; RGBA32Float when `Gpu.float32_filterable`; RGBA8 for a low dynamic range
image). The texture is only read; the caller keeps it.

`Result<GpuTexture, string> Gpu_brdf_lut(*Gpu self, uint32 size, uint32 samples)` makes the
BRDF table alone (`size` 0 is 128, `samples` 0 is 512), for your own shaders.

`float GpuIbl_max_lod(*GpuIbl self)` is the specular cube's last mip level, the one for
roughness 1: sample it at `roughness * max_lod`.

`void GpuIbl_release(*GpuIbl self)` releases the textures and the sampler.

`void GpuModel_set_ibl(*GpuModel self, *GpuIbl ibl)` (in `<gpu/model>`) lights the model with
`ibl`; null goes back to the hemisphere ambient of `GpuModel.light`. The pointer is kept in
`GpuModel.ibl`. The directional light still adds its own term (set `model.light.intensity`
to 0 for environment light only).

### GpuIblOptions

Each field's zero value picks the default.

| Field | Default | Meaning |
|---|---|---|
| `environment_size` | 512 | Face size of the environment cube. |
| `irradiance_size` | 32 | Face size of the irradiance cube. |
| `specular_size` | 128 | Face size of the specular cube's level 0. |
| `specular_mips` | 5 | Number of specular levels (roughness steps), at most the size's mip chain and 16. |
| `brdf_size` | 128 | Width and height of the BRDF table. |
| `samples` | 256 | GGX samples per texel of the specular cube. |
| `brdf_samples` | 512 | GGX samples per texel of the BRDF table. |

### GpuIbl

| Field | Meaning |
|---|---|
| `gpu` | The device it was made on. |
| `environment` | RGBA16Float cube, full mip chain. |
| `irradiance` | RGBA16Float cube. |
| `specular` | RGBA16Float cube, `specular_mips` levels. |
| `brdf` | RG16Float 2D table. |
| `sampler` | Linear filtering with mipmaps, clamped to the edge. |
| `intensity` | Scale of the light the model takes from it; 1 from `Gpu_ibl`. |

## Conventions

- Equirectangular mapping: direction `d` is at `u = atan2(d.z, d.x) / (2 pi) + 0.5` and
  `v = acos(d.y) / pi`, so the top row of the image is straight up (+Y).
- Cube faces are in WebGPU's order +X, -X, +Y, -Y, +Z, -Z, sampled with `texture_cube`.
- In `<gpu/model>` the ambient becomes
  `(irradiance(n) * base * (1 - metallic) * (1 - F) + specular(reflect(-v, n), roughness * max_lod) * (F0 * brdf.r + brdf.g)) * occlusion * intensity`,
  where `F` is Fresnel-Schlick with roughness.

## Caveats

- The model's output is still clamped to 0..1 with no tone mapping, so bright
  environments saturate; lower `intensity` for those.
- Making the textures is a few hundred render passes' worth of work at the default sizes: do
  it once per environment, not per frame. Software rasterizers take seconds at the defaults;
  smaller sizes and sample counts are much faster.
- Seams and noise: the specular cube uses filtered importance sampling, which can still
  show some blockiness at high roughness on small cubes.
