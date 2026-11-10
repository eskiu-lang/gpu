// webgl2.js: the subset of the WebGPU JavaScript API that <gpu/render> uses, over WebGL2.
//
// gpu_open installs it in a browser (src/webgl2.esk embeds this file) and asks the browser's
// WebGPU first: when navigator.gpu is missing or gives no adapter, requestAdapter answers
// with a WebGL2 adapter instead, and emdawnwebgpu drives these objects as if they were the
// browser's. Setting gpuBackend = "webgl2" on Module (or on globalThis) skips WebGPU, and
// "webgpu" turns the fallback off.
//
// Shaders stay WGSL: gpu-naga.wasm (tools/naga-wasm, naga's GLSL writer) turns each entry
// point into GLSL ES 3.00 and says which uniform block and sampler stands for each
// @group/@binding. Bind groups become uniform buffer slots and texture units at each draw.
// The GLSL flips Y in clip space, so a texture's rows are stored top row first as in WebGPU
// and a frame is flipped once, when it is copied to its canvas.
//
// Not available (each one a validation error, as WebGPU reports its own): compute, storage
// buffers and textures, views of a texture in another format, sampling one layer of an
// array texture as a 2D texture, reading depth textures back, base vertex, query sets and
// render bundles.

(function () {
  "use strict";
  if (globalThis.__gpuWebGL2) return;
  const G = (globalThis.__gpuWebGL2 = { active: false, error: "" });

  const BU = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
  const TU = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

  // WebGPU's error classes, for browsers without WebGPU (emdawnwebgpu tests instanceof).
  if (typeof globalThis.GPUError === "undefined") {
    globalThis.GPUError = class GPUError {
      constructor(message) { this.message = String(message); }
    };
  }
  for (const n of ["GPUValidationError", "GPUOutOfMemoryError", "GPUInternalError"]) {
    if (typeof globalThis[n] === "undefined") {
      globalThis[n] = { [n]: class extends globalThis.GPUError {} }[n];
    }
  }

  // Outside a browser (node) there is nothing to fall back to.
  if (typeof WebGL2RenderingContext === "undefined") {
    G.install = () => (typeof navigator !== "undefined" && navigator.gpu ? 1 : 0);
    return;
  }

  function backendWanted() {
    const m = typeof Module !== "undefined" ? Module : null;
    return (m && m.gpuBackend) || globalThis.gpuBackend || "";
  }

  // ---------------------------------------------------------------------------------------
  // gpu-naga.wasm

  let naga = null;
  let nagaLoading = null;

  function nagaUrl() {
    const m = typeof Module !== "undefined" ? Module : null;
    if (m && m.gpuNagaUrl) return m.gpuNagaUrl;
    if (globalThis.gpuNagaUrl) return globalThis.gpuNagaUrl;
    if (m && typeof m.locateFile === "function") return m.locateFile("gpu-naga.wasm", "");
    if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
      return new URL("gpu-naga.wasm", document.currentScript.src).href;
    }
    return "gpu-naga.wasm";
  }

  async function loadNaga() {
    if (naga) return naga;
    if (!nagaLoading) {
      nagaLoading = (async () => {
        const m = typeof Module !== "undefined" ? Module : null;
        let bytes = m && m.gpuNagaWasm;
        if (!bytes) {
          const url = nagaUrl();
          let r;
          try {
            r = await fetch(url);
          } catch (e) {
            throw new Error(`WebGL2: cannot load ${url} (${e.message}); put gpu-naga.wasm next to the page or set Module.gpuNagaUrl`);
          }
          if (!r.ok) throw new Error(`WebGL2: cannot load ${url} (HTTP ${r.status}); put gpu-naga.wasm next to the page or set Module.gpuNagaUrl`);
          bytes = await r.arrayBuffer();
        }
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const e = instance.exports;
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        const put = (s) => {
          const b = enc.encode(s);
          const p = e.gn_alloc(b.length);
          new Uint8Array(e.memory.buffer, p, b.length).set(b);
          return [p, b.length];
        };
        const out = () => dec.decode(new Uint8Array(e.memory.buffer, e.gn_out(), e.gn_out_len()));
        naga = {
          module(src) {
            const [p, n] = put(src);
            const id = e.gn_module(p, n);
            e.gn_free(p, n);
            return id ? { id } : { error: out() };
          },
          translate(id, entry, stage) {
            const [p, n] = put(entry || "");
            const ok = e.gn_translate(id, p, n, stage);
            e.gn_free(p, n);
            return ok ? JSON.parse(out()) : { error: out() };
          },
          drop(id) { e.gn_drop(id); },
        };
        return naga;
      })();
      nagaLoading.catch(() => { nagaLoading = null; });
    }
    return nagaLoading;
  }

  // ---------------------------------------------------------------------------------------
  // Formats

  const GL = WebGL2RenderingContext;
  // name: [internal format, format, type, bytes per texel, components, kind]
  // kind: f (float or normalized), u (unsigned integer), s (signed integer), d (depth)
  const FORMATS = {
    "r8unorm": [GL.R8, GL.RED, GL.UNSIGNED_BYTE, 1, 1, "f"],
    "r8snorm": [GL.R8_SNORM, GL.RED, GL.BYTE, 1, 1, "f"],
    "r8uint": [GL.R8UI, GL.RED_INTEGER, GL.UNSIGNED_BYTE, 1, 1, "u"],
    "r8sint": [GL.R8I, GL.RED_INTEGER, GL.BYTE, 1, 1, "s"],
    "r16uint": [GL.R16UI, GL.RED_INTEGER, GL.UNSIGNED_SHORT, 2, 1, "u"],
    "r16sint": [GL.R16I, GL.RED_INTEGER, GL.SHORT, 2, 1, "s"],
    "r16float": [GL.R16F, GL.RED, GL.HALF_FLOAT, 2, 1, "f"],
    "rg8unorm": [GL.RG8, GL.RG, GL.UNSIGNED_BYTE, 2, 2, "f"],
    "rg8snorm": [GL.RG8_SNORM, GL.RG, GL.BYTE, 2, 2, "f"],
    "rg8uint": [GL.RG8UI, GL.RG_INTEGER, GL.UNSIGNED_BYTE, 2, 2, "u"],
    "rg8sint": [GL.RG8I, GL.RG_INTEGER, GL.BYTE, 2, 2, "s"],
    "r32float": [GL.R32F, GL.RED, GL.FLOAT, 4, 1, "f"],
    "r32uint": [GL.R32UI, GL.RED_INTEGER, GL.UNSIGNED_INT, 4, 1, "u"],
    "r32sint": [GL.R32I, GL.RED_INTEGER, GL.INT, 4, 1, "s"],
    "rg16uint": [GL.RG16UI, GL.RG_INTEGER, GL.UNSIGNED_SHORT, 4, 2, "u"],
    "rg16sint": [GL.RG16I, GL.RG_INTEGER, GL.SHORT, 4, 2, "s"],
    "rg16float": [GL.RG16F, GL.RG, GL.HALF_FLOAT, 4, 2, "f"],
    "rgba8unorm": [GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 4, 4, "f"],
    "rgba8unorm-srgb": [GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 4, 4, "f"],
    "rgba8snorm": [GL.RGBA8_SNORM, GL.RGBA, GL.BYTE, 4, 4, "f"],
    "rgba8uint": [GL.RGBA8UI, GL.RGBA_INTEGER, GL.UNSIGNED_BYTE, 4, 4, "u"],
    "rgba8sint": [GL.RGBA8I, GL.RGBA_INTEGER, GL.BYTE, 4, 4, "s"],
    "bgra8unorm": [GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 4, 4, "f"],
    "bgra8unorm-srgb": [GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 4, 4, "f"],
    "rgb10a2unorm": [GL.RGB10_A2, GL.RGBA, GL.UNSIGNED_INT_2_10_10_10_REV, 4, 4, "f"],
    "rgb10a2uint": [GL.RGB10_A2UI, GL.RGBA_INTEGER, GL.UNSIGNED_INT_2_10_10_10_REV, 4, 4, "u"],
    "rg11b10ufloat": [GL.R11F_G11F_B10F, GL.RGB, GL.UNSIGNED_INT_10F_11F_11F_REV, 4, 3, "f"],
    "rgb9e5ufloat": [GL.RGB9_E5, GL.RGB, GL.UNSIGNED_INT_5_9_9_9_REV, 4, 3, "f"],
    "rg32float": [GL.RG32F, GL.RG, GL.FLOAT, 8, 2, "f"],
    "rg32uint": [GL.RG32UI, GL.RG_INTEGER, GL.UNSIGNED_INT, 8, 2, "u"],
    "rg32sint": [GL.RG32I, GL.RG_INTEGER, GL.INT, 8, 2, "s"],
    "rgba16uint": [GL.RGBA16UI, GL.RGBA_INTEGER, GL.UNSIGNED_SHORT, 8, 4, "u"],
    "rgba16sint": [GL.RGBA16I, GL.RGBA_INTEGER, GL.SHORT, 8, 4, "s"],
    "rgba16float": [GL.RGBA16F, GL.RGBA, GL.HALF_FLOAT, 8, 4, "f"],
    "rgba32float": [GL.RGBA32F, GL.RGBA, GL.FLOAT, 16, 4, "f"],
    "rgba32uint": [GL.RGBA32UI, GL.RGBA_INTEGER, GL.UNSIGNED_INT, 16, 4, "u"],
    "rgba32sint": [GL.RGBA32I, GL.RGBA_INTEGER, GL.INT, 16, 4, "s"],
    "stencil8": [GL.DEPTH24_STENCIL8, GL.DEPTH_STENCIL, GL.UNSIGNED_INT_24_8, 4, 1, "d"],
    "depth16unorm": [GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT, GL.UNSIGNED_SHORT, 2, 1, "d"],
    "depth24plus": [GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, 4, 1, "d"],
    "depth24plus-stencil8": [GL.DEPTH24_STENCIL8, GL.DEPTH_STENCIL, GL.UNSIGNED_INT_24_8, 4, 1, "d"],
    "depth32float": [GL.DEPTH_COMPONENT32F, GL.DEPTH_COMPONENT, GL.FLOAT, 4, 1, "d"],
    "depth32float-stencil8": [GL.DEPTH32F_STENCIL8, GL.DEPTH_STENCIL, GL.FLOAT_32_UNSIGNED_INT_24_8_REV, 8, 1, "d"],
  };

  // Block-compressed formats: [internal format, block width, block height, bytes, feature].
  const COMPRESSED = {};
  {
    const bc = [
      ["bc1-rgba-unorm", 0x83f1, 8], ["bc1-rgba-unorm-srgb", 0x8c4d, 8],
      ["bc2-rgba-unorm", 0x83f2, 16], ["bc2-rgba-unorm-srgb", 0x8c4e, 16],
      ["bc3-rgba-unorm", 0x83f3, 16], ["bc3-rgba-unorm-srgb", 0x8c4f, 16],
      ["bc4-r-unorm", 0x8dbb, 8], ["bc4-r-snorm", 0x8dbc, 8],
      ["bc5-rg-unorm", 0x8dbd, 16], ["bc5-rg-snorm", 0x8dbe, 16],
      ["bc6h-rgb-ufloat", 0x8e8f, 16], ["bc6h-rgb-float", 0x8e8e, 16],
      ["bc7-rgba-unorm", 0x8e8c, 16], ["bc7-rgba-unorm-srgb", 0x8e8d, 16],
    ];
    for (const [n, f, b] of bc) COMPRESSED[n] = [f, 4, 4, b, "texture-compression-bc"];
    const etc = [
      ["etc2-rgb8unorm", 0x9274, 8], ["etc2-rgb8unorm-srgb", 0x9275, 8],
      ["etc2-rgb8a1unorm", 0x9276, 8], ["etc2-rgb8a1unorm-srgb", 0x9277, 8],
      ["etc2-rgba8unorm", 0x9278, 16], ["etc2-rgba8unorm-srgb", 0x9279, 16],
      ["eac-r11unorm", 0x9270, 8], ["eac-r11snorm", 0x9271, 8],
      ["eac-rg11unorm", 0x9272, 16], ["eac-rg11snorm", 0x9273, 16],
    ];
    for (const [n, f, b] of etc) COMPRESSED[n] = [f, 4, 4, b, "texture-compression-etc2"];
    const astc = [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]];
    astc.forEach(([w, h], i) => {
      COMPRESSED[`astc-${w}x${h}-unorm`] = [0x93b0 + i, w, h, 16, "texture-compression-astc"];
      COMPRESSED[`astc-${w}x${h}-unorm-srgb`] = [0x93d0 + i, w, h, 16, "texture-compression-astc"];
    });
  }

  const VERTEX_FORMATS = {
    "uint8": [1, GL.UNSIGNED_BYTE, false, true], "uint8x2": [2, GL.UNSIGNED_BYTE, false, true], "uint8x4": [4, GL.UNSIGNED_BYTE, false, true],
    "sint8": [1, GL.BYTE, false, true], "sint8x2": [2, GL.BYTE, false, true], "sint8x4": [4, GL.BYTE, false, true],
    "unorm8": [1, GL.UNSIGNED_BYTE, true, false], "unorm8x2": [2, GL.UNSIGNED_BYTE, true, false], "unorm8x4": [4, GL.UNSIGNED_BYTE, true, false],
    "snorm8": [1, GL.BYTE, true, false], "snorm8x2": [2, GL.BYTE, true, false], "snorm8x4": [4, GL.BYTE, true, false],
    "uint16": [1, GL.UNSIGNED_SHORT, false, true], "uint16x2": [2, GL.UNSIGNED_SHORT, false, true], "uint16x4": [4, GL.UNSIGNED_SHORT, false, true],
    "sint16": [1, GL.SHORT, false, true], "sint16x2": [2, GL.SHORT, false, true], "sint16x4": [4, GL.SHORT, false, true],
    "unorm16": [1, GL.UNSIGNED_SHORT, true, false], "unorm16x2": [2, GL.UNSIGNED_SHORT, true, false], "unorm16x4": [4, GL.UNSIGNED_SHORT, true, false],
    "snorm16": [1, GL.SHORT, true, false], "snorm16x2": [2, GL.SHORT, true, false], "snorm16x4": [4, GL.SHORT, true, false],
    "float16": [1, GL.HALF_FLOAT, false, false], "float16x2": [2, GL.HALF_FLOAT, false, false], "float16x4": [4, GL.HALF_FLOAT, false, false],
    "float32": [1, GL.FLOAT, false, false], "float32x2": [2, GL.FLOAT, false, false], "float32x3": [3, GL.FLOAT, false, false], "float32x4": [4, GL.FLOAT, false, false],
    "uint32": [1, GL.UNSIGNED_INT, false, true], "uint32x2": [2, GL.UNSIGNED_INT, false, true], "uint32x3": [3, GL.UNSIGNED_INT, false, true], "uint32x4": [4, GL.UNSIGNED_INT, false, true],
    "sint32": [1, GL.INT, false, true], "sint32x2": [2, GL.INT, false, true], "sint32x3": [3, GL.INT, false, true], "sint32x4": [4, GL.INT, false, true],
    "unorm10-10-10-2": [4, GL.UNSIGNED_INT_2_10_10_10_REV, true, false],
  };

  const COMPARE = {
    "never": GL.NEVER, "less": GL.LESS, "equal": GL.EQUAL, "less-equal": GL.LEQUAL,
    "greater": GL.GREATER, "not-equal": GL.NOTEQUAL, "greater-equal": GL.GEQUAL, "always": GL.ALWAYS,
  };
  const STENCIL_OP = {
    "keep": GL.KEEP, "zero": GL.ZERO, "replace": GL.REPLACE, "invert": GL.INVERT,
    "increment-clamp": GL.INCR, "decrement-clamp": GL.DECR, "increment-wrap": GL.INCR_WRAP, "decrement-wrap": GL.DECR_WRAP,
  };
  const BLEND_FACTOR = {
    "zero": GL.ZERO, "one": GL.ONE, "src": GL.SRC_COLOR, "one-minus-src": GL.ONE_MINUS_SRC_COLOR,
    "src-alpha": GL.SRC_ALPHA, "one-minus-src-alpha": GL.ONE_MINUS_SRC_ALPHA, "dst": GL.DST_COLOR,
    "one-minus-dst": GL.ONE_MINUS_DST_COLOR, "dst-alpha": GL.DST_ALPHA, "one-minus-dst-alpha": GL.ONE_MINUS_DST_ALPHA,
    "src-alpha-saturated": GL.SRC_ALPHA_SATURATE, "constant": GL.CONSTANT_COLOR, "one-minus-constant": GL.ONE_MINUS_CONSTANT_COLOR,
  };
  const BLEND_OP = { "add": GL.FUNC_ADD, "subtract": GL.FUNC_SUBTRACT, "reverse-subtract": GL.FUNC_REVERSE_SUBTRACT, "min": GL.MIN, "max": GL.MAX };
  const TOPOLOGY = { "point-list": GL.POINTS, "line-list": GL.LINES, "line-strip": GL.LINE_STRIP, "triangle-list": GL.TRIANGLES, "triangle-strip": GL.TRIANGLE_STRIP };
  const WRAP = { "repeat": GL.REPEAT, "mirror-repeat": GL.MIRRORED_REPEAT, "clamp-to-edge": GL.CLAMP_TO_EDGE };

  function extent(s) {
    if (Array.isArray(s)) return [s[0] | 0, s[1] === undefined ? 1 : s[1] | 0, s[2] === undefined ? 1 : s[2] | 0];
    return [s.width | 0, s.height === undefined ? 1 : s.height | 0, s.depthOrArrayLayers === undefined ? 1 : s.depthOrArrayLayers | 0];
  }

  function origin(o) {
    if (!o) return [0, 0, 0];
    if (Array.isArray(o)) return [o[0] | 0, o[1] | 0, o[2] | 0];
    return [o.x | 0, o.y | 0, o.z | 0];
  }

  function hasStencil(format) {
    return format === "stencil8" || format === "depth24plus-stencil8" || format === "depth32float-stencil8";
  }

  function hasDepth(format) {
    return format !== "stencil8" && FORMATS[format] && FORMATS[format][5] === "d";
  }

  // Swaps R and B in a copy of RGBA8 pixels (bgra8unorm is stored as RGBA8).
  function swapRB(bytes) {
    const o = new Uint8Array(bytes);
    for (let i = 0; i + 3 < o.length; i += 4) {
      const t = o[i];
      o[i] = o[i + 2];
      o[i + 2] = t;
    }
    return o;
  }

  // A typed array over a copy of bytes, for the GL upload type.
  function typedFor(type, bytes) {
    const copy = bytes.slice();
    const b = copy.buffer;
    switch (type) {
      case GL.FLOAT: return new Float32Array(b, 0, b.byteLength >> 2);
      case GL.HALF_FLOAT: case GL.UNSIGNED_SHORT: return new Uint16Array(b, 0, b.byteLength >> 1);
      case GL.SHORT: return new Int16Array(b, 0, b.byteLength >> 1);
      case GL.INT: return new Int32Array(b, 0, b.byteLength >> 2);
      case GL.UNSIGNED_INT: case GL.UNSIGNED_INT_2_10_10_10_REV: case GL.UNSIGNED_INT_10F_11F_11F_REV:
      case GL.UNSIGNED_INT_5_9_9_9_REV: case GL.UNSIGNED_INT_24_8: return new Uint32Array(b, 0, b.byteLength >> 2);
      case GL.BYTE: return new Int8Array(b);
      default: return copy;
    }
  }

  function f32ToF16(v) {
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    f[0] = v;
    const x = u[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15;
    let m = x & 0x7fffff;
    if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
    if (e >= 31) return sign | 0x7c00;
    if (e <= 0) {
      if (e < -10) return sign;
      m = (m | 0x800000) >>> (1 - e);
      return sign | ((m + 0x1000) >>> 13);
    }
    return (sign | (e << 10) | (m >>> 13)) + ((m >>> 12) & 1);
  }

  let nextId = 1;

  // ---------------------------------------------------------------------------------------
  // GPU, adapter, device

  class GLAdapter {
    constructor(gl, canvas) {
      this.gl = gl;
      this.canvas = canvas;
      const ext = (n) => gl.getExtension(n);
      this.ext = {
        colorFloat: ext("EXT_color_buffer_float"),
        colorHalf: ext("EXT_color_buffer_half_float"),
        floatLinear: ext("OES_texture_float_linear"),
        floatBlend: ext("EXT_float_blend"),
        aniso: ext("EXT_texture_filter_anisotropic"),
        indexed: ext("OES_draw_buffers_indexed"),
        baseVertex: ext("WEBGL_draw_instanced_base_vertex_base_instance"),
        s3tc: ext("WEBGL_compressed_texture_s3tc"),
        s3tcSrgb: ext("WEBGL_compressed_texture_s3tc_srgb"),
        rgtc: ext("EXT_texture_compression_rgtc"),
        bptc: ext("EXT_texture_compression_bptc"),
        etc: ext("WEBGL_compressed_texture_etc"),
        astc: ext("WEBGL_compressed_texture_astc"),
        debug: ext("WEBGL_debug_renderer_info"),
      };
      const f = new Set(["depth32float-stencil8"]);
      if (this.ext.floatLinear) f.add("float32-filterable");
      if (this.ext.floatBlend) f.add("float32-blendable");
      if (this.ext.s3tc && this.ext.s3tcSrgb && this.ext.rgtc && this.ext.bptc) f.add("texture-compression-bc");
      if (this.ext.etc) f.add("texture-compression-etc2");
      if (this.ext.astc) f.add("texture-compression-astc");
      this.features = f;
      const p = (n) => gl.getParameter(n);
      const units = Math.min(16, p(gl.MAX_TEXTURE_IMAGE_UNITS), p(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS));
      this.limits = {
        maxTextureDimension1D: p(gl.MAX_TEXTURE_SIZE),
        maxTextureDimension2D: p(gl.MAX_TEXTURE_SIZE),
        maxTextureDimension3D: p(gl.MAX_3D_TEXTURE_SIZE),
        maxTextureArrayLayers: p(gl.MAX_ARRAY_TEXTURE_LAYERS),
        maxBindGroups: 4,
        maxBindGroupsPlusVertexBuffers: 24,
        maxBindingsPerBindGroup: 1000,
        maxDynamicUniformBuffersPerPipelineLayout: 8,
        maxDynamicStorageBuffersPerPipelineLayout: 0,
        maxSampledTexturesPerShaderStage: units,
        maxSamplersPerShaderStage: units,
        maxStorageBuffersPerShaderStage: 0,
        maxStorageTexturesPerShaderStage: 0,
        maxUniformBuffersPerShaderStage: Math.min(12, p(gl.MAX_VERTEX_UNIFORM_BLOCKS), p(gl.MAX_FRAGMENT_UNIFORM_BLOCKS)),
        minUniformBufferOffsetAlignment: Math.max(256, p(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)),
        minStorageBufferOffsetAlignment: 256,
        maxUniformBufferBindingSize: p(gl.MAX_UNIFORM_BLOCK_SIZE),
        maxStorageBufferBindingSize: 0,
        maxVertexBuffers: 8,
        maxBufferSize: 1 << 30,
        maxVertexAttributes: Math.min(16, p(gl.MAX_VERTEX_ATTRIBS)),
        maxVertexBufferArrayStride: 255,
        maxInterStageShaderVariables: Math.min(16, p(gl.MAX_VARYING_VECTORS)),
        maxColorAttachments: Math.min(8, p(gl.MAX_DRAW_BUFFERS), p(gl.MAX_COLOR_ATTACHMENTS)),
        maxColorAttachmentBytesPerSample: 32,
        maxComputeWorkgroupStorageSize: 0,
        maxComputeInvocationsPerWorkgroup: 0,
        maxComputeWorkgroupSizeX: 0,
        maxComputeWorkgroupSizeY: 0,
        maxComputeWorkgroupSizeZ: 0,
        maxComputeWorkgroupsPerDimension: 0,
        maxImmediateSize: 0,
      };
      const renderer = this.ext.debug ? p(this.ext.debug.UNMASKED_RENDERER_WEBGL) : p(gl.RENDERER);
      this.info = {
        vendor: "webgl2", architecture: "", device: `${renderer} (WebGL2)`, description: p(gl.VERSION),
        subgroupMinSize: 0, subgroupMaxSize: 0, isFallbackAdapter: false,
      };
      this.isFallbackAdapter = false;
    }

    async requestDevice() {
      return new GLDevice(this);
    }
  }

  async function glAdapter() {
    let canvas;
    if (typeof document !== "undefined") canvas = document.createElement("canvas");
    else if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(1, 1);
    else throw new Error("WebGL2: no canvas in this context");
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("no WebGPU or WebGL2 in this browser");
    await loadNaga();
    G.active = true;
    return new GLAdapter(gl, canvas);
  }

  class GLQueue {
    constructor(device) { this.device = device; this.label = ""; }

    submit(buffers) {
      const d = this.device;
      for (const cb of buffers) {
        if (cb._used) {
          d._error("validation", "a command buffer was submitted twice");
          continue;
        }
        cb._used = true;
        if (cb._error) {
          d._error("validation", cb._error);
          continue;
        }
        for (const op of cb._ops) {
          try {
            op();
          } catch (e) {
            d._error("validation", e.message || String(e));
          }
        }
      }
      d._schedulePresent();
    }

    writeBuffer(buffer, offset, data, dataOffset, size) {
      let bytes;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const el = data.BYTES_PER_ELEMENT || 1;
      const start = (dataOffset || 0) * el;
      const len = size === undefined ? bytes.length - start : size * el;
      if (offset + len > buffer.size) {
        this.device._error("validation", `writeBuffer: ${len} bytes at ${offset} overrun a buffer of ${buffer.size}`);
        return;
      }
      buffer._write(offset, bytes.subarray(start, start + len));
    }

    writeTexture(dest, data, layout, size) {
      let bytes;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      try {
        dest.texture._upload(dest, bytes, layout, extent(size));
      } catch (e) {
        this.device._error("validation", e.message);
      }
    }

    onSubmittedWorkDone() {
      return Promise.resolve();
    }
  }

  class GLDevice {
    constructor(adapter) {
      this.adapter = adapter;
      this.adapterInfo = adapter.info;
      this.gl = adapter.gl;
      this.features = adapter.features;
      this.limits = adapter.limits;
      this.queue = new GLQueue(this);
      this.label = "";
      this.onuncapturederror = null;
      this._scopes = [];
      this._fbos = new Map();
      this._contexts = new Set();
      this._presentPending = false;
      this._lostResolve = null;
      this.lost = new Promise((r) => { this._lostResolve = r; });
      const gl = this.gl;
      this._vao = gl.createVertexArray();
      gl.bindVertexArray(this._vao);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      this._enabledAttribs = new Set();
      this._readFbo = gl.createFramebuffer();
      this._drawFbo = gl.createFramebuffer();
      if (adapter.canvas.addEventListener) {
        adapter.canvas.addEventListener("webglcontextlost", () => {
          if (this._lostResolve) this._lostResolve({ reason: "unknown", message: "the WebGL2 context was lost" });
        });
      }
    }

    // lost stays pending on destroy: the program has let go of the device by then.
    destroy() {
      this._lostResolve = null;
    }

    addEventListener() {}
    removeEventListener() {}

    pushErrorScope(filter) {
      this._scopes.push({ filter, error: null });
    }

    popErrorScope() {
      const s = this._scopes.pop();
      if (!s) return Promise.reject(new DOMException("no error scope to pop", "OperationError"));
      return Promise.resolve(s.error);
    }

    _error(filter, message) {
      const msg = String(message);
      for (let i = this._scopes.length - 1; i >= 0; i--) {
        const s = this._scopes[i];
        if (s.filter === filter) {
          if (!s.error) {
            s.error = filter === "out-of-memory" ? new GPUOutOfMemoryError(msg)
              : filter === "internal" ? new GPUInternalError(msg) : new GPUValidationError(msg);
          }
          return;
        }
      }
      const error = new GPUValidationError(msg);
      if (typeof this.onuncapturederror === "function") this.onuncapturederror({ error });
      else console.warn("WebGPU (WebGL2):", msg);
    }

    createBuffer(desc) {
      return new GLBuffer(this, desc);
    }

    createTexture(desc) {
      return new GLTexture(this, desc);
    }

    createSampler(desc) {
      return new GLSampler(this, desc || {});
    }

    createShaderModule(desc) {
      return new GLShaderModule(this, desc);
    }

    createBindGroupLayout(desc) {
      for (const e of desc.entries || []) {
        if (e.buffer && (e.buffer.type === "storage" || e.buffer.type === "read-only-storage")) {
          this._error("validation", `bind group layout: storage buffers (binding ${e.binding}) are not available in WebGL2`);
        }
        if (e.storageTexture) this._error("validation", `bind group layout: storage textures (binding ${e.binding}) are not available in WebGL2`);
        if (e.externalTexture) this._error("validation", `bind group layout: external textures are not available in WebGL2`);
      }
      return new GLBindGroupLayout(desc.entries || [], false);
    }

    createPipelineLayout(desc) {
      return { label: desc.label || "", bindGroupLayouts: desc.bindGroupLayouts || [] };
    }

    createBindGroup(desc) {
      return new GLBindGroup(this, desc);
    }

    createRenderPipeline(desc) {
      return new GLRenderPipeline(this, desc);
    }

    createRenderPipelineAsync(desc) {
      this.pushErrorScope("validation");
      const p = new GLRenderPipeline(this, desc);
      return this.popErrorScope().then((e) => {
        if (e) throw Object.assign(new Error(e.message), { name: "GPUPipelineError", reason: "validation" });
        return p;
      });
    }

    createComputePipeline() {
      this._error("validation", "compute pipelines are not available in WebGL2, the backend of browsers without WebGPU");
      return { label: "", getBindGroupLayout: () => new GLBindGroupLayout([], true) };
    }

    createComputePipelineAsync() {
      return Promise.reject(Object.assign(new Error("compute pipelines are not available in WebGL2"), { name: "GPUPipelineError", reason: "validation" }));
    }

    createCommandEncoder() {
      return new GLCommandEncoder(this);
    }

    createQuerySet() {
      this._error("validation", "query sets are not available in WebGL2");
      return { destroy() {} };
    }

    createRenderBundleEncoder() {
      throw new Error("render bundles are not available in WebGL2");
    }

    // A framebuffer for the views (color views or nulls, then the depth view), made once.
    _fbo(colors, depth) {
      const key = colors.map((c) => (c ? c._key() : "-")).join(",") + "|" + (depth ? depth._key() : "-");
      let f = this._fbos.get(key);
      if (f) return f;
      const gl = this.gl;
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const bufs = [];
      colors.forEach((v, i) => {
        if (v) v._attach(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i);
        bufs.push(v ? gl.COLOR_ATTACHMENT0 + i : gl.NONE);
      });
      if (depth) {
        const point = hasStencil(depth.format) ? (hasDepth(depth.format) ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_STENCIL_ATTACHMENT) : gl.DEPTH_ATTACHMENT;
        depth._attach(gl.FRAMEBUFFER, point);
      }
      gl.drawBuffers(bufs.length ? bufs : [gl.NONE]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      f = { fb, status, key, textures: new Set() };
      for (const v of colors) if (v) f.textures.add(v.texture);
      if (depth) f.textures.add(depth.texture);
      this._fbos.set(key, f);
      return f;
    }

    _forget(texture) {
      for (const [k, f] of this._fbos) {
        if (f.textures.has(texture)) {
          this.gl.deleteFramebuffer(f.fb);
          this._fbos.delete(k);
        }
      }
    }

    // Copies each canvas frame drawn since the last copy to its canvas, once the program
    // lets the browser run (before the canvas is shown).
    _schedulePresent() {
      if (this._presentPending) return;
      let dirty = false;
      for (const c of this._contexts) if (c._texture && c._texture._dirty) dirty = true;
      if (!dirty) return;
      this._presentPending = true;
      queueMicrotask(() => {
        this._presentPending = false;
        for (const c of this._contexts) c._present();
      });
    }

    _setAttribs(used) {
      const gl = this.gl;
      for (const loc of this._enabledAttribs) {
        if (!used.has(loc)) {
          gl.disableVertexAttribArray(loc);
          this._enabledAttribs.delete(loc);
        }
      }
      for (const loc of used) {
        if (!this._enabledAttribs.has(loc)) {
          gl.enableVertexAttribArray(loc);
          this._enabledAttribs.add(loc);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Buffers

  class GLBuffer {
    constructor(device, desc) {
      this.device = device;
      this.label = desc.label || "";
      this.size = Number(desc.size);
      this.usage = desc.usage;
      this.mapState = desc.mappedAtCreation ? "mapped" : "unmapped";
      this._shadow = new Uint8Array(Math.ceil(this.size / 16) * 16);
      this._data = null;
      this._index = null;
      this._mapped = [];
      this._mapMode = desc.mappedAtCreation ? 2 : 0;
      if (this.usage & BU.STORAGE) {
        // Allowed to exist (a buffer may carry several usages); binding one as storage fails.
      }
      if (this.size > device.limits.maxBufferSize) device._error("validation", `buffer of ${this.size} bytes is above maxBufferSize`);
    }

    // The GL buffer for vertex and uniform data, made on first use.
    _glData() {
      if (!this._data) {
        const gl = this.device.gl;
        this._data = gl.createBuffer();
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._data);
        gl.bufferData(gl.COPY_WRITE_BUFFER, this._shadow, gl.DYNAMIC_DRAW);
      }
      return this._data;
    }

    // The GL buffer for indices (WebGL2 keeps index buffers apart from other targets).
    _glIndex() {
      if (!this._index) {
        const gl = this.device.gl;
        this._index = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._index);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this._shadow, gl.DYNAMIC_DRAW);
      }
      return this._index;
    }

    _write(offset, bytes) {
      this._shadow.set(bytes, offset);
      this._sync(offset, bytes.length);
    }

    _sync(offset, len) {
      const gl = this.device.gl;
      const part = this._shadow.subarray(offset, offset + len);
      if (this._data) {
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._data);
        gl.bufferSubData(gl.COPY_WRITE_BUFFER, offset, part);
      }
      if (this._index) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._index);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, part);
      }
    }

    mapAsync(mode, offset, size) {
      if (this.mapState !== "unmapped") {
        return Promise.reject(new DOMException("the buffer is mapped already", "OperationError"));
      }
      this.mapState = "mapped";
      this._mapMode = mode;
      return Promise.resolve();
    }

    getMappedRange(offset, size) {
      if (this.mapState !== "mapped") throw new DOMException("the buffer is not mapped", "OperationError");
      const off = offset || 0;
      const len = size === undefined ? this.size - off : size;
      const ab = this._shadow.slice(off, off + len).buffer;
      this._mapped.push([off, ab]);
      return ab;
    }

    unmap() {
      if (this.mapState !== "mapped") return;
      if (this._mapMode & 2) {
        for (const [off, ab] of this._mapped) this._write(off, new Uint8Array(ab));
      }
      this._mapped = [];
      this.mapState = "unmapped";
    }

    destroy() {
      const gl = this.device.gl;
      if (this._data) gl.deleteBuffer(this._data);
      if (this._index) gl.deleteBuffer(this._index);
      this._data = null;
      this._index = null;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Textures, views, samplers

  class GLTexture {
    constructor(device, desc) {
      this.device = device;
      this._label = desc.label || "";
      const [w, h, d] = extent(desc.size);
      this.width = w;
      this.height = h;
      this.depthOrArrayLayers = d;
      this.mipLevelCount = desc.mipLevelCount || 1;
      this.sampleCount = desc.sampleCount || 1;
      this.dimension = desc.dimension || "2d";
      this.format = desc.format;
      this.usage = desc.usage;
      this._id = nextId++;
      this._fmt = FORMATS[this.format];
      this._cmp = COMPRESSED[this.format];
      this._target = 0;
      this._tex = null;
      this._rb = null;
      this._dirty = false;
      this._levels = [0, 1000];
      this._hint = desc.textureBindingViewDimension;
      const viewFormats = (desc.viewFormats || []).filter((f) => f !== this.format);
      if (!this._fmt && !this._cmp) {
        device._error("validation", `texture format ${this.format} is not available in WebGL2`);
      } else if (this._cmp && !device.features.has(this._cmp[4])) {
        device._error("validation", `texture format ${this.format} needs ${this._cmp[4]}`);
      } else if (viewFormats.length) {
        device._error("validation", `textures viewed in another format (view formats ${viewFormats.join(", ")}) are not available in WebGL2`);
      } else if (this.sampleCount > 1 && (d > 1 || this.mipLevelCount > 1)) {
        device._error("validation", "multisampled textures have one layer and one mip level");
      }
      if (this._fmt && this.format === "bgra8unorm-srgb") this._fmt = FORMATS["rgba8unorm-srgb"];
      this._bgra = this.format === "bgra8unorm" || this.format === "bgra8unorm-srgb";
    }

    get label() { return this._label; }

    set label(v) {
      this._label = v;
      // render.esk's generate_mips on WebGL2: each level is the 2x2 box filter of the one
      // above, as render.esk's own shader makes it on WebGPU.
      if (v === "__gpu_generate_mipmap") {
        try {
          this._generateMips();
        } catch (e) {
          this.device._error("validation", `generate_mips: ${e.message}`);
        }
      }
    }

    _generateMips() {
      const dev = this.device;
      const gl = dev.gl;
      this._alloc();
      if (!this._tex || !this._fmt || this._fmt[5] !== "f") throw new Error("the format cannot be rendered into and filtered");
      if (!dev._mipProg) {
        const vs = "#version 300 es\nvoid main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n";
        const fs = "#version 300 es\nprecision highp float;\nuniform highp sampler2D src;\nout vec4 o;\n"
          + "void main() {\n  ivec2 last = textureSize(src, 0) - 1;\n  ivec2 p = ivec2(gl_FragCoord.xy) * 2;\n"
          + "  o = (texelFetch(src, min(p, last), 0) + texelFetch(src, min(p + ivec2(1, 0), last), 0)\n"
          + "     + texelFetch(src, min(p + ivec2(0, 1), last), 0) + texelFetch(src, min(p + ivec2(1, 1), last), 0)) * 0.25;\n}\n";
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(prog);
        dev._mipProg = prog;
        dev._mipFbo = gl.createFramebuffer();
      }
      const layers = this._target === gl.TEXTURE_3D ? 1 : this.depthOrArrayLayers;
      gl.useProgram(dev._mipProg);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.colorMask(true, true, true, true);
      dev._setAttribs(new Set());
      gl.activeTexture(gl.TEXTURE0);
      gl.bindSampler(0, null);
      for (let level = 1; level < this.mipLevelCount; level++) {
        const sw = Math.max(1, this.width >> (level - 1));
        const sh = Math.max(1, this.height >> (level - 1));
        // Each layer's level above goes into a 2D texture of its own, which GL can sample.
        const tmp = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tmp);
        gl.texStorage2D(gl.TEXTURE_2D, 1, this._fmt[0], sw, sh);
        for (let layer = 0; layer < layers; layer++) {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dev._readFbo);
          this._attachLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, level - 1, layer);
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dev._mipFbo);
          gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmp, 0);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
          gl.blitFramebuffer(0, 0, sw, sh, 0, 0, sw, sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
          gl.bindFramebuffer(gl.FRAMEBUFFER, dev._drawFbo);
          this._attachLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, level, layer);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
          gl.viewport(0, 0, Math.max(1, this.width >> level), Math.max(1, this.height >> level));
          gl.bindTexture(gl.TEXTURE_2D, tmp);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteTexture(tmp);
      }
    }

    // Makes the GL texture on first use; the first view decides between a cube and an array.
    _alloc(viewDim) {
      if (this._tex || this._rb) return;
      if (!this._fmt && !this._cmp) throw new Error(`texture format ${this.format} is not available in WebGL2`);
      const gl = this.device.gl;
      const internal = this._fmt ? this._fmt[0] : this._cmp[0];
      if (this.sampleCount > 1) {
        this._rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this._rb);
        const max = gl.getInternalformatParameter(gl.RENDERBUFFER, internal, gl.SAMPLES);
        const samples = max && max.length ? Math.min(this.sampleCount, max[0]) : this.sampleCount;
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internal, this.width, this.height);
        return;
      }
      const d = this.depthOrArrayLayers;
      const dim = this._hint || viewDim;
      if (this.dimension === "3d") this._target = gl.TEXTURE_3D;
      else if (dim === "cube" || (!dim && d === 6 && this.width === this.height)) this._target = gl.TEXTURE_CUBE_MAP;
      else if (dim === "cube-array") throw new Error("cube arrays are not available in WebGL2");
      else if (d > 1 || dim === "2d-array") this._target = gl.TEXTURE_2D_ARRAY;
      else this._target = gl.TEXTURE_2D;
      this._tex = gl.createTexture();
      gl.bindTexture(this._target, this._tex);
      if (this._target === gl.TEXTURE_2D || this._target === gl.TEXTURE_CUBE_MAP) {
        gl.texStorage2D(this._target, this.mipLevelCount, internal, this.width, this.height);
      } else {
        gl.texStorage3D(this._target, this.mipLevelCount, internal, this.width, this.height, d);
      }
      gl.texParameteri(this._target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(this._target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(this._target, gl.TEXTURE_MAX_LEVEL, this.mipLevelCount - 1);
      this._levels = [0, this.mipLevelCount - 1];
    }

    createView(desc) {
      return new GLTextureView(this, desc || {});
    }

    destroy() {
      const gl = this.device.gl;
      this.device._forget(this);
      if (this._tex) gl.deleteTexture(this._tex);
      if (this._rb) gl.deleteRenderbuffer(this._rb);
      this._tex = null;
      this._rb = null;
    }

    // The GL target that one layer of a 2D or cube texture is written through.
    _faceTarget(layer) {
      const gl = this.device.gl;
      return this._target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer : this._target;
    }

    _upload(dest, bytes, layout, size) {
      const gl = this.device.gl;
      this._alloc();
      if (!this._tex) throw new Error("writeTexture: a multisampled texture cannot be written");
      const [x, y, z] = origin(dest.origin);
      const level = dest.mipLevel || 0;
      let [w, h, d] = size;
      const off = Number(layout.offset || 0);
      gl.bindTexture(this._target, this._tex);
      if (this._cmp) {
        const [internal, bw, bh, bb] = this._cmp;
        const lw = Math.max(1, this.width >> level);
        const lh = Math.max(1, this.height >> level);
        const bx = Math.ceil(w / bw);
        const by = Math.ceil(h / bh);
        const row = bx * bb;
        const stride = layout.bytesPerRow || row;
        const rows = layout.rowsPerImage || by;
        const cw = Math.min(w, lw - x);
        const ch = Math.min(h, lh - y);
        for (let k = 0; k < d; k++) {
          const packed = new Uint8Array(row * by);
          for (let r = 0; r < by; r++) {
            const s = off + (k * rows + r) * stride;
            packed.set(bytes.subarray(s, s + row), r * row);
          }
          if (this._target === gl.TEXTURE_2D || this._target === gl.TEXTURE_CUBE_MAP) {
            gl.compressedTexSubImage2D(this._faceTarget(z + k), level, x, y, cw, ch, internal, packed);
          } else {
            gl.compressedTexSubImage3D(this._target, level, x, y, z + k, cw, ch, 1, internal, packed);
          }
        }
        return;
      }
      const [, format, type, bpp] = this._fmt;
      if (this._fmt[5] === "d") throw new Error("writeTexture: depth and stencil textures cannot be written in WebGL2");
      const stride = layout.bytesPerRow || w * bpp;
      const rows = layout.rowsPerImage || h;
      if (stride % bpp !== 0) throw new Error("writeTexture: bytesPerRow must be a multiple of the texel size in WebGL2");
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / bpp);
      gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, rows);
      const span = stride * rows * (d - 1) + stride * (h - 1) + w * bpp;
      let src = bytes.subarray(off, off + span);
      if (this._bgra) src = swapRB(src);
      const data = typedFor(type, src);
      if (this._target === gl.TEXTURE_2D || this._target === gl.TEXTURE_CUBE_MAP) {
        const plane = (stride * rows) / (data.BYTES_PER_ELEMENT || 1);
        for (let k = 0; k < d; k++) {
          gl.texSubImage2D(this._faceTarget(z + k), level, x, y, w, h, format, type, data, k * plane);
        }
      } else {
        gl.texSubImage3D(this._target, level, x, y, z, w, h, d, format, type, data);
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    }

    // Reads w x h texels of one layer and level into out at offset, rows stride bytes apart.
    _readInto(level, layer, x, y, w, h, out, offset, stride) {
      const gl = this.device.gl;
      if (!this._fmt) throw new Error("copyTextureToBuffer: compressed textures cannot be read back in WebGL2");
      const [, , , bpp, comps, kind] = this._fmt;
      if (kind === "d") throw new Error("copyTextureToBuffer: depth and stencil textures cannot be read back in WebGL2");
      if (this.sampleCount > 1) throw new Error("copyTextureToBuffer: a multisampled texture cannot be read back");
      this._alloc();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.device._readFbo);
      this._attachLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, level, layer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const direct = this.format === "rgba8unorm" || this.format === "rgba8unorm-srgb" || this._bgra;
      if (direct && stride % 4 === 0) {
        gl.pixelStorei(gl.PACK_ROW_LENGTH, stride / 4);
        const view = out.subarray(offset, offset + stride * (h - 1) + w * 4);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, view);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
        if (this._bgra) {
          for (let r = 0; r < h; r++) {
            const row = view.subarray(r * stride, r * stride + w * 4);
            row.set(swapRB(row));
          }
        }
        return;
      }
      // Other formats: read RGBA in the format's base type, then pack each texel.
      let rtype, rtmp;
      const name = this.format;
      if (kind === "u") { rtype = gl.UNSIGNED_INT; rtmp = new Uint32Array(w * h * 4); }
      else if (kind === "s") { rtype = gl.INT; rtmp = new Int32Array(w * h * 4); }
      else if (/8unorm|8snorm/.test(name) && !/float/.test(name)) { rtype = gl.UNSIGNED_BYTE; rtmp = new Uint8Array(w * h * 4); }
      else if (/float/.test(name) && !/11|9e5/.test(name)) { rtype = gl.FLOAT; rtmp = new Float32Array(w * h * 4); }
      else throw new Error(`copyTextureToBuffer: ${name} cannot be read back in WebGL2`);
      if (name.includes("snorm")) throw new Error(`copyTextureToBuffer: ${name} cannot be read back in WebGL2`);
      gl.readPixels(x, y, w, h, kind === "u" ? gl.RGBA_INTEGER : kind === "s" ? gl.RGBA_INTEGER : gl.RGBA, rtype, rtmp);
      const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
      const csize = bpp / comps;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          for (let k = 0; k < comps; k++) {
            const v = rtmp[(r * w + c) * 4 + k];
            const at = offset + r * stride + c * bpp + k * csize;
            if (rtype === gl.UNSIGNED_BYTE) dv.setUint8(at, v);
            else if (rtype === gl.FLOAT) {
              if (csize === 2) dv.setUint16(at, f32ToF16(v), true);
              else dv.setFloat32(at, v, true);
            } else if (csize === 1) dv.setUint8(at, v & 0xff);
            else if (csize === 2) dv.setUint16(at, v & 0xffff, true);
            else dv.setUint32(at, v >>> 0, true);
          }
        }
      }
    }

    _attachLayer(target, point, level, layer) {
      const gl = this.device.gl;
      if (this._rb) gl.framebufferRenderbuffer(target, point, gl.RENDERBUFFER, this._rb);
      else if (this._target === gl.TEXTURE_2D) gl.framebufferTexture2D(target, point, gl.TEXTURE_2D, this._tex, level);
      else if (this._target === gl.TEXTURE_CUBE_MAP) gl.framebufferTexture2D(target, point, gl.TEXTURE_CUBE_MAP_POSITIVE_X + layer, this._tex, level);
      else gl.framebufferTextureLayer(target, point, this._tex, level, layer);
    }
  }

  class GLTextureView {
    constructor(texture, desc) {
      this.texture = texture;
      this.label = desc.label || "";
      this.format = desc.format || texture.format;
      const layers = texture.depthOrArrayLayers;
      this.baseMipLevel = desc.baseMipLevel || 0;
      this.mipLevelCount = desc.mipLevelCount === undefined ? texture.mipLevelCount - this.baseMipLevel : desc.mipLevelCount;
      this.baseArrayLayer = desc.baseArrayLayer || 0;
      let dim = desc.dimension;
      if (!dim) dim = texture.dimension === "3d" ? "3d" : layers > 1 ? "2d-array" : "2d";
      this.dimension = dim;
      this.arrayLayerCount = desc.arrayLayerCount === undefined
        ? (dim === "2d" || dim === "3d" ? 1 : dim === "cube" ? 6 : layers - this.baseArrayLayer) : desc.arrayLayerCount;
      this.aspect = desc.aspect || "all";
      const dev = texture.device;
      if (this.format !== texture.format) {
        dev._error("validation", `a view in another format (${this.format} of a ${texture.format} texture) is not available in WebGL2`);
      }
      // The whole texture's first view decides how it is stored.
      if (this.baseArrayLayer === 0 && (dim === "cube" || dim === "2d-array" || layers === 1)) {
        try {
          texture._alloc(dim);
        } catch (e) {
          dev._error("validation", e.message);
        }
      }
    }

    _key() {
      return `t${this.texture._id}:${this.baseMipLevel}:${this.baseArrayLayer}`;
    }

    _attach(target, point) {
      this.texture._alloc();
      this.texture._attachLayer(target, point, this.baseMipLevel, this.baseArrayLayer);
    }

    // The GL target to sample this view through; throws when GL cannot sample it.
    _sampleTarget() {
      const t = this.texture;
      const gl = t.device.gl;
      t._alloc(this.dimension);
      if (!t._tex) throw new Error("a multisampled texture cannot be sampled in WebGL2");
      const want = { "2d": gl.TEXTURE_2D, "2d-array": gl.TEXTURE_2D_ARRAY, "cube": gl.TEXTURE_CUBE_MAP, "3d": gl.TEXTURE_3D }[this.dimension];
      if (want !== t._target) {
        throw new Error(`a ${this.dimension} view of this texture cannot be sampled in WebGL2 (one layer of an array or cube texture, or a cube stored as an array)`);
      }
      if (this.aspect === "stencil-only") throw new Error("sampling the stencil of a texture is not available in WebGL2");
      return want;
    }
  }

  class GLSampler {
    constructor(device, d) {
      const gl = device.gl;
      this.device = device;
      this.label = d.label || "";
      const s = (this._s = gl.createSampler());
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, WRAP[d.addressModeU || "clamp-to-edge"]);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, WRAP[d.addressModeV || "clamp-to-edge"]);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_R, WRAP[d.addressModeW || "clamp-to-edge"]);
      const lin = (m) => m === "linear";
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, lin(d.magFilter) ? gl.LINEAR : gl.NEAREST);
      const min = lin(d.minFilter);
      const mip = lin(d.mipmapFilter);
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, min
        ? (mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST)
        : (mip ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST));
      gl.samplerParameterf(s, gl.TEXTURE_MIN_LOD, d.lodMinClamp === undefined ? 0 : d.lodMinClamp);
      gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, d.lodMaxClamp === undefined ? 32 : d.lodMaxClamp);
      if (d.compare) {
        gl.samplerParameteri(s, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.samplerParameteri(s, gl.TEXTURE_COMPARE_FUNC, COMPARE[d.compare]);
      }
      const aniso = device.adapter.ext.aniso;
      if (aniso && d.maxAnisotropy > 1) gl.samplerParameterf(s, aniso.TEXTURE_MAX_ANISOTROPY_EXT, d.maxAnisotropy);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Shaders, layouts, bind groups, pipelines

  class GLShaderModule {
    constructor(device, desc) {
      this.device = device;
      this.label = desc.label || "";
      this._messages = [];
      const r = naga.module(desc.code || "");
      if (r.error) {
        this._id = 0;
        this._messages.push({ type: "error", message: r.error, lineNum: 0, linePos: 0, offset: 0, length: 0 });
        device._error("validation", `shader module: ${r.error}`);
      } else {
        this._id = r.id;
      }
    }

    getCompilationInfo() {
      return Promise.resolve({ messages: this._messages });
    }
  }

  class GLBindGroupLayout {
    constructor(entries, auto) {
      this.label = "";
      this._entries = entries;
      this._auto = auto;
      this._dynamic = entries.filter((e) => e.buffer && e.buffer.hasDynamicOffset).map((e) => e.binding).sort((a, b) => a - b);
    }
  }

  class GLBindGroup {
    constructor(device, desc) {
      this.device = device;
      this.label = desc.label || "";
      this.layout = desc.layout;
      this._res = new Map();
      for (const e of desc.entries || []) {
        let r = e.resource;
        if (r instanceof GLTexture) r = r.createView();
        if (r && r.buffer instanceof GLBuffer && r.buffer.usage & BU.STORAGE && !(r.buffer.usage & BU.UNIFORM)) {
          device._error("validation", `bind group: binding ${e.binding} is a storage buffer, not available in WebGL2`);
        }
        this._res.set(e.binding, r);
      }
    }
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`GLSL compile error: ${log}\n${src}`);
    }
    return s;
  }

  function blendEqual(a, b) {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  }

  class GLRenderPipeline {
    constructor(device, desc) {
      this.device = device;
      this.label = desc.label || "";
      this._ok = false;
      try {
        this._build(desc);
        this._ok = true;
      } catch (e) {
        device._error("validation", `render pipeline: ${e.message}`);
      }
    }

    getBindGroupLayout(i) {
      if (this._layout && this._layout !== "auto" && this._layout.bindGroupLayouts[i]) return this._layout.bindGroupLayouts[i];
      return new GLBindGroupLayout([], true);
    }

    _build(desc) {
      const gl = this.device.gl;
      this._layout = desc.layout;
      const vs = desc.vertex;
      if (!vs.module._id) throw new Error("the vertex shader module is invalid");
      const vr = naga.translate(vs.module._id, vs.entryPoint, 0);
      if (vr.error) throw new Error(`vertex shader: ${vr.error}`);
      let fr = null;
      const fsd = desc.fragment;
      if (fsd) {
        if (!fsd.module._id) throw new Error("the fragment shader module is invalid");
        fr = naga.translate(fsd.module._id, fsd.entryPoint, 1);
        if (fr.error) throw new Error(`fragment shader: ${fr.error}`);
      }
      const fsrc = fr ? fr.glsl : "#version 300 es\nprecision highp float;\nvoid main() {}\n";
      const prog = gl.createProgram();
      const v = compile(gl, gl.VERTEX_SHADER, vr.glsl);
      const f = compile(gl, gl.FRAGMENT_SHADER, fsrc);
      gl.attachShader(prog, v);
      gl.attachShader(prog, f);
      gl.linkProgram(prog);
      gl.deleteShader(v);
      gl.deleteShader(f);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`GLSL link error: ${log}`);
      }
      this._prog = prog;
      gl.useProgram(prog);
      // Uniform blocks: one buffer slot per (group, binding).
      const slots = new Map();
      this._blocks = [];
      for (const r of [vr, fr]) {
        if (!r) continue;
        for (const [name, g, b] of r.blocks) {
          const idx = gl.getUniformBlockIndex(prog, name);
          if (idx === gl.INVALID_INDEX) continue;
          const key = g * 4096 + b;
          if (!slots.has(key)) {
            slots.set(key, slots.size);
            this._blocks.push({ group: g, binding: b, slot: slots.get(key), size: 0 });
          }
          const blk = this._blocks[slots.get(key)];
          blk.size = Math.max(blk.size, gl.getActiveUniformBlockParameter(prog, idx, gl.UNIFORM_BLOCK_DATA_SIZE));
          gl.uniformBlockBinding(prog, idx, slots.get(key));
        }
      }
      // Combined samplers: one texture unit per (texture, sampler) pair.
      const units = new Map();
      this._units = [];
      for (const r of [vr, fr]) {
        if (!r) continue;
        for (const [name, g, b, sg, sb] of r.textures) {
          const loc = gl.getUniformLocation(prog, name);
          if (!loc) continue;
          const key = `${g}/${b}/${sg}/${sb}`;
          if (!units.has(key)) {
            units.set(key, units.size);
            this._units.push({ group: g, binding: b, sgroup: sg, sbinding: sb, unit: units.get(key) });
          }
          gl.uniform1i(loc, units.get(key));
        }
      }
      this._firstInstance = vr.first_instance ? gl.getUniformLocation(prog, "naga_vs_first_instance") : null;
      // Vertex buffers.
      this._buffers = (vs.buffers || []).map((b) => {
        if (!b) return null;
        const stride = Number(b.arrayStride);
        if (stride > 255) throw new Error(`a vertex stride of ${stride} bytes is above WebGL2's 255`);
        const attrs = (b.attributes || []).map((a) => {
          const f = VERTEX_FORMATS[a.format];
          if (!f) throw new Error(`vertex format ${a.format} is not available in WebGL2`);
          return { loc: a.shaderLocation, size: f[0], type: f[1], norm: f[2], int: f[3], offset: Number(a.offset) };
        });
        return { stride, instance: b.stepMode === "instance", attrs };
      });
      this._attribs = new Set();
      for (const b of this._buffers) if (b) for (const a of b.attrs) this._attribs.add(a.loc);
      // Fixed-function state.
      const prim = desc.primitive || {};
      this._mode = TOPOLOGY[prim.topology || "triangle-list"];
      this._cull = prim.cullMode === "front" ? gl.FRONT : prim.cullMode === "back" ? gl.BACK : 0;
      // The GLSL flips Y, which turns the winding around.
      this._front = prim.frontFace === "cw" ? gl.CCW : gl.CW;
      const ds = desc.depthStencil;
      if (ds && !hasStencil(ds.format)) {
        const busy = (f) => f && ((f.compare && f.compare !== "always") || [f.failOp, f.depthFailOp, f.passOp].some((o) => o && o !== "keep"));
        if (busy(ds.stencilFront) || busy(ds.stencilBack)) throw new Error(`stencil state needs a depth format with a stencil, not ${ds.format}`);
      }
      this._ds = ds ? {
        format: ds.format,
        write: !!ds.depthWriteEnabled,
        compare: COMPARE[ds.depthCompare || "always"],
        front: ds.stencilFront || {},
        back: ds.stencilBack || {},
        readMask: ds.stencilReadMask === undefined ? 0xff : ds.stencilReadMask,
        writeMask: ds.stencilWriteMask === undefined ? 0xff : ds.stencilWriteMask,
        bias: ds.depthBias || 0,
        slope: ds.depthBiasSlopeScale || 0,
      } : null;
      this._samples = (desc.multisample && desc.multisample.count) || 1;
      this._a2c = !!(desc.multisample && desc.multisample.alphaToCoverageEnabled);
      this._targets = fsd ? (fsd.targets || []) : [];
      const live = this._targets.filter((t) => t);
      this._sameBlend = live.every((t) => blendEqual(t.blend, live[0].blend) && (t.writeMask === undefined ? 15 : t.writeMask) === (live[0].writeMask === undefined ? 15 : live[0].writeMask));
      if (!this._sameBlend && !this.device.adapter.ext.indexed) {
        throw new Error("color targets with different blending or write masks need OES_draw_buffers_indexed");
      }
      for (const t of live) {
        if (FORMATS[t.format] && /32float/.test(t.format) && t.blend && !this.device.features.has("float32-blendable")) {
          throw new Error(`blending into ${t.format} needs EXT_float_blend`);
        }
      }
    }

    _applyBlend(i, t) {
      const gl = this.device.gl;
      const ext = this.device.adapter.ext.indexed;
      const mask = t.writeMask === undefined ? 15 : t.writeMask;
      const m = [!!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8)];
      const kind = FORMATS[t.format] ? FORMATS[t.format][5] : "f";
      const blend = t.blend && kind === "f";
      if (i < 0) {
        gl.colorMask(m[0], m[1], m[2], m[3]);
        if (blend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
      } else {
        ext.colorMaskiOES(i, m[0], m[1], m[2], m[3]);
        if (blend) ext.enableiOES(gl.BLEND, i);
        else ext.disableiOES(gl.BLEND, i);
      }
      if (!blend) return;
      const c = t.blend.color || {};
      const a = t.blend.alpha || {};
      const eq = [BLEND_OP[c.operation || "add"], BLEND_OP[a.operation || "add"]];
      const fac = [BLEND_FACTOR[c.srcFactor || "one"], BLEND_FACTOR[c.dstFactor || "zero"],
        BLEND_FACTOR[a.srcFactor || "one"], BLEND_FACTOR[a.dstFactor || "zero"]];
      if (i < 0) {
        gl.blendEquationSeparate(eq[0], eq[1]);
        gl.blendFuncSeparate(fac[0], fac[1], fac[2], fac[3]);
      } else {
        ext.blendEquationSeparateiOES(i, eq[0], eq[1]);
        ext.blendFuncSeparateiOES(i, fac[0], fac[1], fac[2], fac[3]);
      }
    }

    // Sets the GL state for draws with this pipeline in pass p.
    _apply(p) {
      const gl = this.device.gl;
      gl.useProgram(this._prog);
      if (this._cull) {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(this._cull);
      } else {
        gl.disable(gl.CULL_FACE);
      }
      gl.frontFace(this._front);
      const live = this._targets.filter((t) => t);
      if (live.length === 0) {
        gl.colorMask(false, false, false, false);
        gl.disable(gl.BLEND);
      } else if (this._sameBlend) {
        this._applyBlend(-1, live[0]);
      } else {
        this._targets.forEach((t, i) => { if (t) this._applyBlend(i, t); });
      }
      if (this._a2c) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      const ds = this._ds;
      const pd = p._depthFormat;
      if (ds && pd && hasDepth(pd)) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(ds.compare);
        gl.depthMask(ds.write && !p._depthReadOnly);
      } else {
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
      }
      if (ds && (ds.bias || ds.slope)) {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(ds.slope, ds.bias);
      } else {
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      if (ds && pd && hasStencil(pd)) {
        gl.enable(gl.STENCIL_TEST);
        for (const [face, s] of [[gl.FRONT, ds.front], [gl.BACK, ds.back]]) {
          gl.stencilFuncSeparate(face, COMPARE[s.compare || "always"], p._stencilRef, ds.readMask);
          gl.stencilOpSeparate(face, STENCIL_OP[s.failOp || "keep"], STENCIL_OP[s.depthFailOp || "keep"], STENCIL_OP[s.passOp || "keep"]);
          gl.stencilMaskSeparate(face, p._stencilReadOnly ? 0 : ds.writeMask);
        }
      } else {
        gl.disable(gl.STENCIL_TEST);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Command encoding: commands are recorded and run at submit, in queue order.

  class GLCommandEncoder {
    constructor(device) {
      this.device = device;
      this.label = "";
      this._ops = [];
      this._error = null;
      this._open = null;
    }

    _fail(msg) {
      if (!this._error) this._error = msg;
    }

    beginRenderPass(desc) {
      const p = new GLRenderPassEncoder(this, desc);
      this._open = p;
      return p;
    }

    beginComputePass() {
      this._fail("compute passes are not available in WebGL2");
      const noop = () => {};
      return { setPipeline: noop, setBindGroup: noop, dispatchWorkgroups: noop, dispatchWorkgroupsIndirect: noop, end: noop,
        pushDebugGroup: noop, popDebugGroup: noop, insertDebugMarker: noop, label: "" };
    }

    copyTextureToBuffer(src, dst, size) {
      const [w, h, d] = extent(size);
      const [x, y, z] = origin(src.origin);
      const tex = src.texture;
      const level = src.mipLevel || 0;
      const buf = dst.buffer;
      const off = Number(dst.offset || 0);
      const fmt = FORMATS[tex.format];
      const stride = dst.bytesPerRow || w * (fmt ? fmt[3] : 4);
      const rows = dst.rowsPerImage || h;
      this._ops.push(() => {
        for (let k = 0; k < d; k++) {
          tex._readInto(level, z + k, x, y, w, h, buf._shadow, off + k * rows * stride, stride);
        }
        buf._sync(off, Math.min(buf.size - off, rows * stride * d));
      });
    }

    copyBufferToTexture(src, dst, size) {
      const s = extent(size);
      this._ops.push(() => {
        dst.texture._upload(dst, src.buffer._shadow, { offset: src.offset, bytesPerRow: src.bytesPerRow, rowsPerImage: src.rowsPerImage }, s);
      });
    }

    copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) {
      if (typeof srcOffset === "object") {
        // copyBufferToBuffer(src, dst[, size]).
        size = dstOffset;
        dst = srcOffset;
        srcOffset = 0;
        dstOffset = 0;
      }
      this._ops.push(() => {
        const n = size === undefined ? src.size - srcOffset : Number(size);
        dst._write(Number(dstOffset), src._shadow.slice(Number(srcOffset), Number(srcOffset) + n));
      });
    }

    copyTextureToTexture(src, dst, size) {
      const [w, h, d] = extent(size);
      this._ops.push(() => {
        const gl = this.device.gl;
        const [sx, sy, sz] = origin(src.origin);
        const [dx, dy, dz] = origin(dst.origin);
        const st = src.texture;
        const dt = dst.texture;
        st._alloc();
        dt._alloc();
        for (let k = 0; k < d; k++) {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.device._readFbo);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.device._drawFbo);
          const depth = FORMATS[st.format] && FORMATS[st.format][5] === "d";
          const point = depth ? (hasStencil(st.format) ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT) : gl.COLOR_ATTACHMENT0;
          st._attachLayer(gl.READ_FRAMEBUFFER, point, src.mipLevel || 0, sz + k);
          dt._attachLayer(gl.DRAW_FRAMEBUFFER, point, dst.mipLevel || 0, dz + k);
          const bits = depth ? (hasStencil(st.format) ? gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT : gl.DEPTH_BUFFER_BIT) : gl.COLOR_BUFFER_BIT;
          gl.blitFramebuffer(sx, sy, sx + w, sy + h, dx, dy, dx + w, dy + h, bits, gl.NEAREST);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        dt._dirty = true;
      });
    }

    clearBuffer(buffer, offset, size) {
      this._ops.push(() => {
        const o = Number(offset || 0);
        const n = size === undefined ? buffer.size - o : Number(size);
        buffer._write(o, new Uint8Array(n));
      });
    }

    resolveQuerySet() { this._fail("query sets are not available in WebGL2"); }
    writeTimestamp() { this._fail("timestamps are not available in WebGL2"); }
    pushDebugGroup() {}
    popDebugGroup() {}
    insertDebugMarker() {}

    finish() {
      const cb = { label: "", _ops: this._ops, _error: this._error, _used: false };
      this._ops = [];
      return cb;
    }
  }

  class GLRenderPassEncoder {
    constructor(encoder, desc) {
      this.encoder = encoder;
      this.label = desc.label || "";
      this._cmds = [];
      this._desc = desc;
      const colors = (desc.colorAttachments || []).map((c) => c || null);
      this._colors = colors;
      this._depth = desc.depthStencilAttachment || null;
      const views = colors.filter((c) => c).map((c) => c.view);
      if (this._depth) views.push(this._depth.view);
      if (views.length === 0) encoder._fail("a render pass needs an attachment");
      this._w = views.length ? Math.max(1, views[0].texture.width >> views[0].baseMipLevel) : 1;
      this._h = views.length ? Math.max(1, views[0].texture.height >> views[0].baseMipLevel) : 1;
      if (desc.occlusionQuerySet || desc.timestampWrites) encoder._fail("query sets are not available in WebGL2");
      // What a pipeline drawn in the pass must match, as WebGPU validates it.
      this._formats = colors.map((c) => (c ? c.view.format : null));
      while (this._formats.length && this._formats[this._formats.length - 1] === null) this._formats.pop();
      this._sampleCount = views.length ? views[0].texture.sampleCount : 1;
      this._depthFmt = this._depth ? this._depth.view.format : null;
      for (const c of colors) {
        if (!c || !c.resolveTarget) continue;
        if (c.view.texture.sampleCount === 1) encoder._fail("render pass: a resolve target needs a multisampled attachment");
        if (c.resolveTarget.texture.sampleCount !== 1) encoder._fail("render pass: a resolve target must have one sample");
        if (c.resolveTarget.format !== c.view.format) encoder._fail("render pass: a resolve target must have the attachment's format");
      }
      for (const v of views) {
        if (v.texture.sampleCount !== this._sampleCount) encoder._fail("render pass: the attachments have different sample counts");
      }
    }

    _check(p) {
      if (!p._ok) {
        this.encoder._fail("draw: the pipeline is invalid");
        return;
      }
      const t = p._targets.map((x) => (x ? x.format : null));
      while (t.length && t[t.length - 1] === null) t.pop();
      const n = Math.max(t.length, this._formats.length);
      for (let i = 0; i < n; i++) {
        const pf = t[i] || null;
        const af = this._formats[i] || null;
        if (pf !== af) {
          this.encoder._fail(`draw: the pipeline's color target ${i} is ${pf || "none"} and the pass's attachment is ${af || "none"}`);
          return;
        }
      }
      if (p._samples !== this._sampleCount) {
        this.encoder._fail(`draw: the pipeline has ${p._samples} samples and the pass's attachments ${this._sampleCount}`);
      }
      const pd = p._ds ? p._ds.format : null;
      if (pd !== this._depthFmt) {
        this.encoder._fail(`draw: the pipeline's depth format is ${pd || "none"} and the pass's depth attachment is ${this._depthFmt || "none"}`);
      }
    }

    setPipeline(p) {
      this._cmds.push(["pipeline", p]);
      this._pipe = p;
      this._checked = false;
    }

    _checkLast() {
      if (this._checked) return;
      this._checked = true;
      if (!this._pipe) this.encoder._fail("draw: no pipeline set");
      else this._check(this._pipe);
    }
    setBindGroup(i, g, offsets) { this._cmds.push(["group", i, g, offsets ? Array.from(offsets) : []]); }
    setVertexBuffer(slot, b, offset, size) { this._cmds.push(["vb", slot, b, Number(offset || 0)]); }
    setIndexBuffer(b, format, offset, size) { this._cmds.push(["ib", b, format, Number(offset || 0)]); }
    setViewport(x, y, w, h, mn, mx) { this._cmds.push(["viewport", x, y, w, h, mn, mx]); }
    setScissorRect(x, y, w, h) { this._cmds.push(["scissor", x, y, w, h]); }
    setStencilReference(r) { this._cmds.push(["stencil", r]); }
    setBlendConstant(c) { this._cmds.push(["blend", Array.isArray(c) ? c : [c.r, c.g, c.b, c.a]]); }
    draw(count, instances, first, firstInstance) {
      this._checkLast();
      this._cmds.push(["draw", count, instances === undefined ? 1 : instances, first || 0, firstInstance || 0]);
    }
    drawIndexed(count, instances, firstIndex, baseVertex, firstInstance) {
      this._checkLast();
      this._cmds.push(["drawIndexed", count, instances === undefined ? 1 : instances, firstIndex || 0, baseVertex || 0, firstInstance || 0]);
    }
    drawIndirect() { this.encoder._fail("indirect draws are not available in WebGL2"); }
    drawIndexedIndirect() { this.encoder._fail("indirect draws are not available in WebGL2"); }
    executeBundles() { this.encoder._fail("render bundles are not available in WebGL2"); }
    beginOcclusionQuery() { this.encoder._fail("occlusion queries are not available in WebGL2"); }
    endOcclusionQuery() {}
    pushDebugGroup() {}
    popDebugGroup() {}
    insertDebugMarker() {}

    end() {
      const cmds = this._cmds;
      this._cmds = [];
      this.encoder._ops.push(() => this._run(cmds));
    }

    _run(cmds) {
      const dev = this.encoder.device;
      const gl = dev.gl;
      const colors = this._colors;
      const ds = this._depth;
      const fbo = dev._fbo(colors.map((c) => (c ? c.view : null)), ds ? ds.view : null);
      if (fbo.status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`render pass: the attachments cannot be rendered into together (framebuffer status 0x${fbo.status.toString(16)}; float targets need EXT_color_buffer_float)`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.RASTERIZER_DISCARD);
      // Load ops.
      gl.colorMask(true, true, true, true);
      if (dev.adapter.ext.indexed) for (let i = 0; i < colors.length; i++) dev.adapter.ext.indexed.colorMaskiOES(i, true, true, true, true);
      colors.forEach((c, i) => {
        if (!c) return;
        c.view.texture._dirty = true;
        if (c.loadOp !== "clear") return;
        const v = c.clearValue || { r: 0, g: 0, b: 0, a: 0 };
        const rgba = Array.isArray(v) ? v : [v.r, v.g, v.b, v.a];
        const kind = FORMATS[c.view.format] ? FORMATS[c.view.format][5] : "f";
        if (kind === "u") gl.clearBufferuiv(gl.COLOR, i, new Uint32Array(rgba));
        else if (kind === "s") gl.clearBufferiv(gl.COLOR, i, new Int32Array(rgba));
        else gl.clearBufferfv(gl.COLOR, i, new Float32Array(rgba));
      });
      this._depthFormat = ds ? ds.view.format : null;
      this._depthReadOnly = !!(ds && ds.depthReadOnly);
      this._stencilReadOnly = !!(ds && ds.stencilReadOnly);
      if (ds) {
        const f = ds.view.format;
        const cd = hasDepth(f) && ds.depthLoadOp === "clear";
        const cs = hasStencil(f) && ds.stencilLoadOp === "clear";
        gl.depthMask(true);
        gl.stencilMask(0xff);
        const dv = ds.depthClearValue === undefined ? 1 : ds.depthClearValue;
        const sv = ds.stencilClearValue || 0;
        if (cd && cs) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, dv, sv);
        else if (cd) gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([dv]));
        else if (cs) gl.clearBufferiv(gl.STENCIL, 0, new Int32Array([sv]));
      }
      // Pass defaults.
      gl.viewport(0, 0, this._w, this._h);
      gl.depthRange(0, 1);
      gl.blendColor(0, 0, 0, 0);
      this._stencilRef = 0;
      let pipe = null;
      let stale = true;
      const groups = [];
      const vbs = [];
      let ib = null;
      for (const c of cmds) {
        switch (c[0]) {
          case "pipeline":
            pipe = c[1];
            stale = true;
            break;
          case "group":
            groups[c[1]] = [c[2], c[3]];
            break;
          case "vb":
            vbs[c[1]] = [c[2], c[3]];
            break;
          case "ib":
            ib = [c[1], c[2], c[3]];
            break;
          case "viewport":
            gl.viewport(c[1], c[2], c[3], c[4]);
            gl.depthRange(c[5], c[6]);
            break;
          case "scissor":
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(c[1], c[2], c[3], c[4]);
            break;
          case "stencil":
            this._stencilRef = c[1];
            stale = true;
            break;
          case "blend":
            gl.blendColor(c[1][0], c[1][1], c[1][2], c[1][3]);
            break;
          case "draw":
          case "drawIndexed": {
            if (!pipe || !pipe._ok) throw new Error("draw: no valid pipeline set");
            if (stale) {
              pipe._apply(this);
              stale = false;
            }
            const indexed = c[0] === "drawIndexed";
            const firstInstance = indexed ? c[5] : c[4];
            this._bind(pipe, groups, vbs, firstInstance);
            if (pipe._firstInstance) gl.uniform1ui(pipe._firstInstance, firstInstance);
            if (!indexed) {
              gl.drawArraysInstanced(pipe._mode, c[3], c[1], c[2]);
            } else {
              if (!ib) throw new Error("drawIndexed: no index buffer set");
              const [b, fmt, off] = ib;
              const size = fmt === "uint16" ? 2 : 4;
              gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b._glIndex());
              const type = size === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
              if (c[4] !== 0) {
                const ext = dev.adapter.ext.baseVertex;
                if (!ext) throw new Error("drawIndexed: a base vertex is not available in WebGL2");
                ext.drawElementsInstancedBaseVertexBaseInstanceWEBGL(pipe._mode, c[1], type, off + c[3] * size, c[2], c[4], 0);
              } else {
                gl.drawElementsInstanced(pipe._mode, c[1], type, off + c[3] * size, c[2]);
              }
            }
            break;
          }
        }
      }
      // Multisample resolves and discards.
      const resolves = colors.map((c, i) => (c && c.resolveTarget ? [i, c] : null)).filter((x) => x);
      for (const [i, c] of resolves) {
        const dst = dev._fbo([c.resolveTarget], null);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.fb);
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
        gl.blitFramebuffer(0, 0, this._w, this._h, 0, 0, this._w, this._h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        c.resolveTarget.texture._dirty = true;
      }
      const drop = [];
      colors.forEach((c, i) => { if (c && c.storeOp === "discard") drop.push(gl.COLOR_ATTACHMENT0 + i); });
      if (ds && ds.depthStoreOp === "discard" && ds.stencilStoreOp !== "store") drop.push(hasStencil(ds.view.format) ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT);
      if (drop.length) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, drop);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Binds the uniform buffers, textures and vertex buffers the pipeline reads.
    _bind(pipe, groups, vbs, firstInstance) {
      const gl = this.encoder.device.gl;
      const res = (g, b, what) => {
        const set = groups[g];
        if (!set) throw new Error(`draw: bind group ${g} is not set`);
        const r = set[0]._res.get(b);
        if (r === undefined) throw new Error(`draw: bind group ${g} has nothing at binding ${b} (${what})`);
        return r;
      };
      for (const blk of pipe._blocks) {
        const r = res(blk.group, blk.binding, "a uniform buffer");
        const set = groups[blk.group];
        let off = Number(r.offset || 0);
        const layout = set[0].layout;
        if (layout && layout._dynamic && layout._dynamic.length && set[1].length) {
          const k = layout._dynamic.indexOf(blk.binding);
          if (k >= 0) off += set[1][k];
        }
        const b = r.buffer;
        let size = r.size === undefined ? b.size - off : Number(r.size);
        size = Math.max(Math.ceil(size / 16) * 16, blk.size);
        size = Math.min(size, b._shadow.length - off);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, blk.slot, b._glData(), off, size);
      }
      for (const u of pipe._units) {
        const view = res(u.group, u.binding, "a texture");
        const target = view._sampleTarget();
        const t = view.texture;
        gl.activeTexture(gl.TEXTURE0 + u.unit);
        gl.bindTexture(target, t._tex);
        const lo = view.baseMipLevel;
        const hi = view.baseMipLevel + view.mipLevelCount - 1;
        if (t._levels[0] !== lo || t._levels[1] !== hi) {
          gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, lo);
          gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, hi);
          t._levels = [lo, hi];
        }
        const s = u.sgroup >= 0 ? res(u.sgroup, u.sbinding, "a sampler") : null;
        gl.bindSampler(u.unit, s ? s._s : null);
      }
      const used = new Set();
      pipe._buffers.forEach((lay, slot) => {
        if (!lay) return;
        const vb = vbs[slot];
        if (!vb) throw new Error(`draw: vertex buffer ${slot} is not set`);
        const [b, off] = vb;
        gl.bindBuffer(gl.ARRAY_BUFFER, b._glData());
        const base = off + (lay.instance ? firstInstance * lay.stride : 0);
        for (const a of lay.attrs) {
          used.add(a.loc);
          if (a.int) gl.vertexAttribIPointer(a.loc, a.size, a.type, lay.stride, base + a.offset);
          else gl.vertexAttribPointer(a.loc, a.size, a.type, a.norm, lay.stride, base + a.offset);
          gl.vertexAttribDivisor(a.loc, lay.instance ? 1 : 0);
        }
      });
      this.encoder.device._setAttribs(used);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Canvases

  class GLCanvasContext {
    constructor(canvas) {
      this.canvas = canvas;
      this._device = null;
      this._texture = null;
      this._ctx2d = null;
      this._format = "rgba8unorm";
      this._alpha = "opaque";
    }

    configure(c) {
      this._device = c.device;
      this._format = c.format;
      this._alpha = c.alphaMode || "opaque";
      if (c.viewFormats && c.viewFormats.some((f) => f !== c.format)) {
        c.device._error("validation", "canvas view formats are not available in WebGL2");
      }
      c.device._contexts.add(this);
      if (!this._ctx2d) {
        this._ctx2d = this.canvas.getContext("2d", { alpha: this._alpha !== "opaque" });
      }
      this._drop();
    }

    unconfigure() {
      if (this._device) this._device._contexts.delete(this);
      this._drop();
      this._device = null;
    }

    _drop() {
      if (this._texture) this._texture.destroy();
      this._texture = null;
    }

    getCurrentTexture() {
      if (!this._device) throw new Error("the canvas is not configured");
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (!this._texture || this._texture.width !== w || this._texture.height !== h) {
        this._drop();
        this._texture = new GLTexture(this._device, {
          size: [w, h, 1], format: this._format, usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC | TU.TEXTURE_BINDING,
        });
      }
      return this._texture;
    }

    // Flips the frame into the WebGL2 canvas's drawing buffer and draws that onto this canvas.
    _present() {
      const t = this._texture;
      if (!t || !t._dirty || !this._device) return;
      t._dirty = false;
      const dev = this._device;
      const gl = dev.gl;
      const src = dev.adapter.canvas;
      const w = t.width;
      const h = t.height;
      if (src.width !== w || src.height !== h) {
        src.width = w;
        src.height = h;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dev._readFbo);
      t._attachLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, 0, 0);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.blitFramebuffer(0, 0, w, h, 0, h, w, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const ctx = this._ctx2d;
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(src, 0, 0, w, h, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Installation

  const contexts = new WeakMap();

  function patchCanvas(proto) {
    if (!proto || proto.__gpuWebGL2) return;
    const orig = proto.getContext;
    proto.getContext = function (type, opts) {
      if (type === "webgpu" && G.active) {
        let c = contexts.get(this);
        if (!c) {
          c = new GLCanvasContext(this);
          contexts.set(this, c);
        }
        return c;
      }
      return orig.call(this, type, opts);
    };
    proto.__gpuWebGL2 = true;
  }

  // Puts a navigator.gpu in place that answers with the browser's WebGPU adapter when there is
  // one and a WebGL2 adapter otherwise. Returns 0 when neither can be had.
  G.install = function () {
    if (typeof navigator === "undefined") return 0;
    if (G.installed) return 1;
    const want = backendWanted();
    const native = navigator.gpu || null;
    if (want === "webgpu") return native ? 1 : 0;
    if (typeof WebGL2RenderingContext === "undefined" && !native) return 0;
    if (typeof HTMLCanvasElement !== "undefined") patchCanvas(HTMLCanvasElement.prototype);
    if (typeof OffscreenCanvas !== "undefined") patchCanvas(OffscreenCanvas.prototype);
    const gpu = {
      async requestAdapter(opts) {
        if (native && want !== "webgl2") {
          let a = null;
          try {
            a = await native.requestAdapter(opts);
          } catch (e) {
            a = null;
          }
          if (a) {
            G.active = false;
            return a;
          }
        }
        return glAdapter();
      },
      getPreferredCanvasFormat() {
        return native && !G.active ? native.getPreferredCanvasFormat() : "rgba8unorm";
      },
      get wgslLanguageFeatures() {
        return native && !G.active && native.wgslLanguageFeatures ? native.wgslLanguageFeatures : new Set();
      },
    };
    Object.defineProperty(navigator, "gpu", { value: gpu, configurable: true, enumerable: true });
    G.installed = true;
    return 1;
  };
})();
