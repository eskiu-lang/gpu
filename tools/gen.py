#!/usr/bin/env python3
"""Generate src/raw.esk (and the layout check programs) from webgpu.h + wgpu.h.

Usage: tools/gen.py INCLUDE_DIR
INCLUDE_DIR holds webgpu.h (or webgpu-headers/webgpu.h) and wgpu.h, as wgpu-native ships them.
"""
import os
import re
import sys

KEYWORDS = set("""let int float double bool char string void struct packed union interface enum fn
operator asm volatile static escaping must_use async await const sizeof free_closure thread_create
thread_join for in while do if else switch match case default break return import extern intrinsic
alloc_with null true false try catch finally throw defer errdefer continue int8 int16 int32 int64 uint
uint8 uint16 uint32 uint64 type""".split())

SCALARS = {
    "uint8_t": "uint8", "uint16_t": "uint16", "uint32_t": "uint32", "uint64_t": "uint64",
    "int8_t": "int8", "int16_t": "int16", "int32_t": "int32", "int64_t": "int64",
    "size_t": "uint64", "int": "int", "float": "float", "double": "double",
}


def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)


def ident(name):
    return name + "_" if name in KEYWORDS else name


class Gen:
    def __init__(self):
        self.handles = []
        self.aliases = {}
        self.enums = []
        self.consts = []
        self.callbacks = []
        self.structs = []
        self.unions = []
        self.funcs = []
        self.known = set()
        self.anon = {}
        self.defines = []

    def ctype(self, t):
        t = t.replace("WGPU_NULLABLE", "").replace("struct ", "").strip()
        stars = t.count("*")
        base = t.replace("*", " ").replace("const", " ").split()
        base = base[0] if base else "void"
        if base == "char" and stars == 1:
            return "string"
        if base == "void":
            return "*" * max(stars, 1) + "void" if stars else "void"
        name = SCALARS.get(base, base)
        return "*" * stars + name

    def fields(self, body):
        out = []
        for decl in body.split(";"):
            decl = " ".join(decl.split())
            if decl:
                fm = re.match(r"(.*?)(\w+)$", decl)
                out.append((self.ctype(fm.group(1)), ident(fm.group(2))))
        return out

    def parse(self, text):
        s = strip_comments(text)
        for m in re.finditer(r"typedef struct (\w+)Impl\* (\w+)", s):
            self.handles.append((m.group(1) + "Impl", m.group(2)))
        for m in re.finditer(r"typedef (uint64_t|uint32_t|WGPUFlags) (\w+)\s*(?:WGPU_\w+)?;", s):
            self.aliases[m.group(2)] = self.ctype(m.group(1)) if m.group(1) != "WGPUFlags" else "uint64"
        for m in re.finditer(r"typedef enum (\w+)\s*\{(.*?)\}\s*\w+", s, re.S):
            members = []
            for item in m.group(2).split(","):
                item = " ".join(item.split())
                if not item:
                    continue
                k, _, v = item.partition("=")
                members.append((k.strip(), v.strip()))
            self.enums.append((m.group(1), members))
        for m in re.finditer(r"#define (WGPU_[A-Z0-9_]+) \((\w+)(?:\((\d+)\))?\)", s):
            v = {"UINT32_MAX": ("uint32", "0xFFFFFFFF"), "UINT64_MAX": ("uint64", "0xFFFFFFFFFFFFFFFF"),
                 "SIZE_MAX": ("uint64", "0xFFFFFFFFFFFFFFFF"), "UINT32_C": ("uint32", m.group(3))}.get(m.group(2))
            if v:
                self.defines.append((v[0], m.group(1), v[1]))
        for m in re.finditer(r"static const (\w+) (\w+) = ([^;]+);", s):
            self.consts.append((m.group(1), m.group(2), " ".join(m.group(3).split())))
        for m in re.finditer(r"typedef [\w\s\*]+?\(\*(\w+)\)\s*\(", s):
            if m.group(1) == "WGPUProc" or not m.group(1).startswith("WGPUProc"):
                self.callbacks.append(m.group(1))
        for m in re.finditer(r"typedef (struct|union) (\w+)\s*\{", s):
            depth, i = 1, m.end()
            while depth:
                depth += {"{": 1, "}": -1}.get(s[i], 0)
                i += 1
            body = s[m.end():i - 1]
            name = m.group(2)
            for u in re.finditer(r"union\s*\{([^{}]*)\}\s*(\w+);", body):
                uname = name + u.group(2)[0].upper() + u.group(2)[1:]
                self.unions.append((uname, self.fields(u.group(1))))
                self.anon[uname] = "((%s*)0)->%s" % (name, u.group(2))
            body = re.sub(r"union\s*\{([^{}]*)\}\s*(\w+);",
                          lambda u: "%s%s %s;" % (name, u.group(2)[0].upper() + u.group(2)[1:], u.group(2)), body)
            (self.structs if m.group(1) == "struct" else self.unions).append((name, self.fields(body)))
        for m in re.finditer(r"^\s*(?:WGPU_EXPORT )?([\w\s\*]+?)\b(wgpu\w+)\(([^;{]*?)\)\s*(?:WGPU_FUNCTION_ATTRIBUTE)?;", s, re.M):
            ret, name, params = m.group(1), m.group(2), " ".join(m.group(3).split())
            if "typedef" in ret:
                continue
            ps = []
            if params and params != "void":
                for i, p in enumerate(params.split(",")):
                    pm = re.match(r"(.*?)(\w+)$", p.strip())
                    ps.append((self.ctype(pm.group(1)), ident(pm.group(2)) if pm.group(2) else "a%d" % i))
            self.funcs.append((self.ctype(ret), name, ps))

    def emit(self):
        out = ["// Generated by tools/gen.py from webgpu.h and wgpu.h (wgpu-native). Do not edit.",
               "// size_t is uint64: wgpu-native targets 64-bit platforms.", "",
               '#if defined(__wasm__) || defined(__ANDROID__) || defined(TARGET_OS_IPHONE) || !(defined(__x86_64__) || defined(__aarch64__))',
               '#error "gpu: the WebGPU modules run on 64-bit macOS, Linux and Windows for now; <gpu/math>, <gpu/image>, <gpu/gltf>, <gpu/obj>, <gpu/gguf> and <gpu/safetensors> work everywhere"',
               '#endif', "",
               '#pragma link("wgpu_native")', ""]
        out.append("type WGPUBool = uint32;")
        out.append("type WGPUFlags = uint64;")
        for name, t in sorted(self.aliases.items()):
            if name not in ("WGPUBool", "WGPUFlags"):
                out.append("type %s = %s;" % (name, t))
        out.append("")
        for impl, name in self.handles:
            out.append("struct %s { int _opaque; }" % impl)
            out.append("type %s = *%s;" % (name, impl))
        out.append("")
        for name in self.callbacks:
            out.append("type %s = *void;" % name)
        out.append("")
        for name, members in self.enums:
            out.append("enum %s {" % name)
            out.append(",\n".join("    %s%s" % (k, " = " + v if v else "") for k, v in members))
            out.append("}")
            out.append("")
        for t, name, v in self.defines:
            out.append("const %s %s = %s;" % (t, name, v))
        for t, name, v in self.consts:
            out.append("const %s %s = %s;" % (self.aliases.get(t, t), name, v))
        out.append("")
        for kind, items in (("struct", self.structs), ("union", self.unions)):
            for name, fields in items:
                out.append("%s %s {" % (kind, name))
                for t, f in fields:
                    out.append("    %s %s;" % (t, f))
                out.append("}")
                out.append("")
        for ret, name, ps in self.funcs:
            out.append("extern %s %s(%s);" % (ret, name, ", ".join("%s %s" % p for p in ps)))
        return "\n".join(out) + "\n"

    def emit_layout(self):
        c = ["#include <stdio.h>", "#include <stddef.h>", '#include "webgpu.h"', '#include "wgpu.h"', "int main(void) {"]
        e = ["import <io>;", "import <gpu/raw>;", "", "int main() {"]
        for kind, items in (("struct", self.structs), ("union", self.unions)):
            for name, fields in items:
                c.append('    printf("%s %%zu\\n", sizeof(%s));' % (name, self.anon.get(name, name)))
                e.append('    printf("%s %%d\\n", (int)sizeof(%s));' % (name, name))
                if kind == "union":
                    continue
                e.append("    { %s v;" % name)
                for t, f in fields:
                    cf = f[:-1] if f.endswith("_") and f[:-1] in KEYWORDS else f
                    c.append('    printf("%s.%s %%zu\\n", offsetof(%s, %s));' % (name, cf, name, cf))
                    e.append('      printf("%s.%s %%d\\n", (int)((*uint8)&v.%s - (*uint8)&v)); ' % (name, cf, f))
                e.append("    }")
        c += ["    return 0;", "}"]
        e += ["    return 0;", "}"]
        return "\n".join(c) + "\n", "\n".join(e) + "\n"


def main():
    inc = sys.argv[1]
    web = os.path.join(inc, "webgpu.h")
    if os.path.exists(os.path.join(inc, "webgpu-headers", "webgpu.h")):
        web = os.path.join(inc, "webgpu-headers", "webgpu.h")
    g = Gen()
    for path in (web, os.path.join(inc, "wgpu.h")):
        with open(path) as f:
            g.parse(f.read())
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "src", "raw.esk"), "w") as f:
        f.write(g.emit())
    c, e = g.emit_layout()
    os.makedirs(os.path.join(root, "tools", "layout"), exist_ok=True)
    with open(os.path.join(root, "tools", "layout", "layout.c"), "w") as f:
        f.write(c)
    with open(os.path.join(root, "tools", "layout", "layout.esk"), "w") as f:
        f.write(e)
    print("handles %d enums %d consts %d structs %d unions %d callbacks %d functions %d" % (
        len(g.handles), len(g.enums), len(g.consts), len(g.structs), len(g.unions), len(g.callbacks), len(g.funcs)))


main()
