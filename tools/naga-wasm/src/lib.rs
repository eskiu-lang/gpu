// gpu-naga: WGSL to GLSL ES 3.00 for the WebGL2 backend of the gpu package (web/webgl2.js).
//
// A plain wasm32-unknown-unknown module with a C ABI and no imports:
//
//   gn_alloc(len) -> ptr              memory for a string the caller writes
//   gn_free(ptr, len)
//   gn_module(src, len) -> id         parses and validates WGSL; 0 on error (gn_out has it)
//   gn_translate(id, ep, len, stage)  one entry point (stage 0 vertex, 1 fragment) to GLSL;
//                                     returns 1 and JSON in gn_out, or 0 and a message
//   gn_drop(id)
//   gn_out() -> ptr, gn_out_len() -> len
//
// The JSON is {"glsl": ..., "blocks": [[name, group, binding]...],
// "textures": [[name, group, binding, sampler group, sampler binding]...],
// "first_instance": bool}: the uniform blocks and combined samplers the GLSL declares,
// with the WGSL resource each one stands for.

use naga::back::glsl;
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};
use std::collections::HashMap;
use std::fmt::Write as _;

struct Parsed {
    module: naga::Module,
    info: ModuleInfo,
}

static mut OUT: String = String::new();
static mut MODULES: Option<HashMap<u32, Parsed>> = None;
static mut NEXT: u32 = 1;

#[allow(static_mut_refs)]
fn out() -> &'static mut String {
    unsafe { &mut OUT }
}

#[allow(static_mut_refs)]
fn modules() -> &'static mut HashMap<u32, Parsed> {
    unsafe { MODULES.get_or_insert_with(HashMap::new) }
}

fn text(ptr: *const u8, len: usize) -> String {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

#[no_mangle]
pub extern "C" fn gn_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn gn_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) }
}

#[no_mangle]
pub extern "C" fn gn_out() -> *const u8 {
    out().as_ptr()
}

#[no_mangle]
pub extern "C" fn gn_out_len() -> usize {
    out().len()
}

#[no_mangle]
pub extern "C" fn gn_module(ptr: *const u8, len: usize) -> u32 {
    let src = text(ptr, len);
    out().clear();
    let module = match naga::front::wgsl::parse_str(&src) {
        Ok(m) => m,
        Err(e) => {
            out().push_str(&e.emit_to_string(&src));
            return 0;
        }
    };
    let mut v = Validator::new(ValidationFlags::all(), Capabilities::default());
    let info = match v.validate(&module) {
        Ok(i) => i,
        Err(e) => {
            let _ = write!(out(), "{}", e.emit_to_string(&src));
            return 0;
        }
    };
    let id = unsafe {
        let id = NEXT;
        NEXT += 1;
        id
    };
    modules().insert(id, Parsed { module, info });
    id
}

#[no_mangle]
pub extern "C" fn gn_drop(id: u32) {
    modules().remove(&id);
}

fn json_str(s: &str, o: &mut String) {
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
}

fn binding_of(m: &naga::Module, h: naga::Handle<naga::GlobalVariable>) -> (i64, i64) {
    match &m.global_variables[h].binding {
        Some(b) => (b.group as i64, b.binding as i64),
        None => (-1, -1),
    }
}

#[no_mangle]
pub extern "C" fn gn_translate(id: u32, ep: *const u8, ep_len: usize, stage: u32) -> u32 {
    let entry = text(ep, ep_len);
    out().clear();
    let Some(p) = modules().get(&id) else {
        out().push_str("no such shader module");
        return 0;
    };
    let shader_stage = if stage == 0 { naga::ShaderStage::Vertex } else { naga::ShaderStage::Fragment };
    // An empty name is the module's only entry point of that stage.
    let mut name = entry.clone();
    if name.is_empty() {
        let found: Vec<&naga::EntryPoint> = p.module.entry_points.iter().filter(|e| e.stage == shader_stage).collect();
        if found.len() != 1 {
            out().push_str("no entry point named, and the module has not exactly one of this stage");
            return 0;
        }
        name = found[0].name.clone();
    }
    let options = glsl::Options {
        version: glsl::Version::Embedded { version: 300, is_webgl: true },
        writer_flags: glsl::WriterFlags::ADJUST_COORDINATE_SPACE | glsl::WriterFlags::FORCE_POINT_SIZE,
        binding_map: Default::default(),
        zero_initialize_workgroup_memory: true,
    };
    let pipeline = glsl::PipelineOptions { shader_stage, entry_point: name, multiview: None };
    let mut code = String::new();
    let policies = naga::proc::BoundsCheckPolicies::default();
    let reflection = match glsl::Writer::new(&mut code, &p.module, &p.info, &options, &pipeline, policies) {
        Ok(mut w) => match w.write() {
            Ok(r) => r,
            Err(e) => {
                let _ = write!(out(), "{e}");
                return 0;
            }
        },
        Err(e) => {
            let _ = write!(out(), "{e}");
            return 0;
        }
    };
    let mut o = String::with_capacity(code.len() + 256);
    o.push_str("{\"glsl\":");
    json_str(&code, &mut o);
    o.push_str(",\"blocks\":[");
    let mut first = true;
    for (h, name) in reflection.uniforms.iter() {
        let (g, b) = binding_of(&p.module, *h);
        if !first {
            o.push(',');
        }
        first = false;
        o.push('[');
        json_str(name, &mut o);
        let _ = write!(o, ",{g},{b}]");
    }
    o.push_str("],\"textures\":[");
    first = true;
    for (name, m) in reflection.texture_mapping.iter() {
        let (g, b) = binding_of(&p.module, m.texture);
        let (sg, sb) = match m.sampler {
            Some(s) => binding_of(&p.module, s),
            None => (-1, -1),
        };
        if !first {
            o.push(',');
        }
        first = false;
        o.push('[');
        json_str(name, &mut o);
        let _ = write!(o, ",{g},{b},{sg},{sb}]");
    }
    let _ = write!(o, "],\"first_instance\":{}}}", code.contains("naga_vs_first_instance"));
    *out() = o;
    1
}
