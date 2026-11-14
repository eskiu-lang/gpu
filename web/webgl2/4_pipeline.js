// webgl2/4_pipeline.js: shader modules, bind groups and render pipelines. Part of the WebGL2 backend; tools/gen_webgl2.py joins web/webgl2/*.js in
// name order into src/webgl2.esk (one script).
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

