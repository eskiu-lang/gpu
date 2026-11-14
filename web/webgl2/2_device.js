// webgl2/2_device.js: the adapter, queue, device and buffers. Part of the WebGL2 backend; tools/gen_webgl2.py joins web/webgl2/*.js in
// name order into src/webgl2.esk (one script).
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

