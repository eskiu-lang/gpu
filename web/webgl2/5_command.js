// webgl2/5_command.js: command encoders, render passes, the canvas context and installing it. Part of the WebGL2 backend; tools/gen_webgl2.py joins web/webgl2/*.js in
// name order into src/webgl2.esk (one script).
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
