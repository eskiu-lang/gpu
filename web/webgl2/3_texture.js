// webgl2/3_texture.js: textures, views and samplers. Part of the WebGL2 backend; tools/gen_webgl2.py joins web/webgl2/*.js in
// name order into src/webgl2.esk (one script).
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

