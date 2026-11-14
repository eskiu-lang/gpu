// webgl2/1_setup.js: the subset of the WebGPU JavaScript API that <gpu/render> uses, over WebGL2.
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

