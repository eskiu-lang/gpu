// Runs a program built for the web (a .js from eskiuc --target wasm32-unknown-emscripten) in
// headless Chrome, Chromium or Brave, prints what it prints, and exits with its exit code.
//
//   node tools/web_run.mjs build/web/triangle.js [--gpu webgl2|webgpu] [--no-webgpu]
//        [--shot out.png] [--frames N] [--timeout ms] [--arg A]...
//
// --gpu sets Module.gpuBackend (webgl2 skips the browser's WebGPU); --no-webgpu starts the
// browser with WebGPU turned off and removes navigator.gpu, as in Firefox or an older
// Safari; --null-adapter only turns it off (navigator.gpu stays and gives no adapter, as on
// a GPU the browser blocks); --swiftshader renders WebGL2 on the CPU (as on a CI runner);
// --shot saves the
// page's canvas once the program ends (or after --frames animation frames). The browser
// is $CHROME, else Chrome, else Brave. gpu-naga.wasm is served from web/.
// The program needs -sEXIT_RUNTIME=1 for its exit code; without it the run ends when it
// prints nothing for a second after main returns.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = { gpu: "", noWebgpu: false, nullAdapter: false, swiftshader: false, shot: "", timeout: 120000, frames: 0, argv: [] };
let script = "";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--gpu") opt.gpu = args[++i];
  else if (a === "--no-webgpu") opt.noWebgpu = true;
  else if (a === "--null-adapter") opt.nullAdapter = true;
  else if (a === "--swiftshader") opt.swiftshader = true;
  else if (a === "--shot") opt.shot = args[++i];
  else if (a === "--timeout") opt.timeout = Number(args[++i]);
  else if (a === "--frames") opt.frames = Number(args[++i]);
  else if (a === "--arg") opt.argv.push(args[++i]);
  else script = a;
}
if (!script) {
  console.error("usage: node tools/web_run.mjs program.js [--gpu webgl2|webgpu] [--no-webgpu] [--shot out.png]");
  process.exit(2);
}

const browsers = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter((b) => b && existsSync(b));
if (!browsers.length) {
  console.error("web_run: no Chrome, Chromium or Brave (set CHROME)");
  process.exit(2);
}

const root = dirname(resolve(script));
const web = resolve(dirname(new URL(import.meta.url).pathname), "..", "web");
const page = `<!doctype html><meta charset="utf-8"><title>gpu</title>
<style>body{margin:0;background:#000}canvas{display:block}</style>
<canvas id="canvas" width="256" height="256"></canvas>
<script>
var Module = {
  canvas: document.getElementById("canvas"),
  arguments: ${JSON.stringify(opt.argv)},
  gpuBackend: ${JSON.stringify(opt.gpu)},
  gpuNagaUrl: "/__web/gpu-naga.wasm",
  print: (s) => console.log(s),
  printErr: (s) => console.error(s),
  onExit: (c) => { if (c === undefined) c = typeof EXITSTATUS !== "undefined" ? EXITSTATUS : 1; console.log("__EXIT__ " + c); },
  onAbort: (r) => { window.__exit = 1; console.log("__ABORT__ " + r); },
};
</script>
<script src="${basename(script)}"></script>`;

const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", ".data": "application/octet-stream" };
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
    return;
  }
  const file = url.startsWith("/__web/") ? join(web, url.slice(7)) : join(root, url);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), "gpu-web-run-"));
const flags = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
  "--hide-scrollbars", "--window-size=1280,1024", "--enable-unsafe-webgpu",
  "--enable-features=WebAssemblyJSPromiseIntegration", "about:blank"];
if (opt.swiftshader) flags.splice(-1, 0, "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader");
if (opt.noWebgpu || opt.nullAdapter) flags.splice(flags.indexOf("--enable-unsafe-webgpu"), 1, "--disable-features=WebGPU,WebGPUService", "--disable-webgpu");
const chrome = spawn(browsers[0], flags, { stdio: ["ignore", "ignore", "pipe"] });
let wsUrl = "";
await new Promise((res, rej) => {
  let buf = "";
  const t = setTimeout(() => rej(new Error("web_run: the browser did not start")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      wsUrl = m[1];
      clearTimeout(t);
      res();
    }
  });
});

let code = 1;
const done = (c) => {
  try { chrome.kill(); } catch {}
  server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(c);
};

try {
  const browserWs = new WebSocket(wsUrl);
  await new Promise((r) => browserWs.addEventListener("open", r));
  let seq = 0;
  const pending = new Map();
  const handlers = [];
  browserWs.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message));
      else res(m.result);
    } else if (m.method) {
      for (const h of handlers) h(m);
    }
  });
  // A page busy in a long synchronous call answers late; the run's timeout still holds.
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    browserWs.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`${method}: no answer from the browser`));
      }
    }, Math.min(opt.timeout, 30000));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  let last = Date.now();
  let exited = null;
  let mainReturned = false;
  handlers.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled") {
      const text = m.params.args.map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" ");
      last = Date.now();
      const e = text.match(/^__EXIT__ (-?\d+)/);
      if (e) exited = Number(e[1]);
      else if (/^__ABORT__/.test(text)) { console.log(text); exited = 1; }
      else (m.params.type === "error" ? console.error : console.log)(text);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.error("exception:", d.exception ? d.exception.description : d.text);
      last = Date.now();
    }
  });
  await s("Runtime.enable");
  await s("Page.enable");
  if (opt.noWebgpu) {
    await s("Page.addScriptToEvaluateOnNewDocument", { source: "delete Navigator.prototype.gpu; for (const k of Object.getOwnPropertyNames(self)) if (/^GPU/.test(k)) delete self[k];" });
  }
  await s("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  const start = Date.now();
  let frames = 0;
  while (exited === null) {
    await new Promise((r) => setTimeout(r, 100));
    if (Date.now() - start > opt.timeout) {
      const st = await s("Runtime.evaluate", { expression: "JSON.stringify([document.readyState, typeof calledRun !== 'undefined' && calledRun, typeof runDependencies !== 'undefined' ? runDependencies : -1])", returnByValue: true }).then((r) => r.result.value, (e) => e.message);
      console.error(`web_run: timed out (page state ${st})`);
      break;
    }
    if (opt.frames) {
      frames = await s("Runtime.evaluate", { expression: "window.__frames = (window.__frames||0)+0, (() => { if (!window.__counting) { window.__counting = 1; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); } return window.__frames; })()", returnByValue: true }).then((r) => r.result.value);
      if (frames >= opt.frames) break;
    }
    if (!mainReturned) {
      const r = await s("Runtime.evaluate", { expression: "typeof calledRun !== 'undefined' && calledRun && typeof runtimeKeepaliveCounter !== 'undefined' ? runtimeKeepaliveCounter : -1", returnByValue: true });
      mainReturned = r.result.value === 0;
    } else if (Date.now() - last > 1000) {
      exited = 0;
    }
  }
  if (opt.shot) {
    const r = await s("Runtime.evaluate", { expression: "(() => { const c = document.getElementById('canvas'); const b = c.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()", returnByValue: true });
    const [x, y, w, h] = r.result.value;
    const shot = await s("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: 1 } });
    writeFileSync(opt.shot, Buffer.from(shot.data, "base64"));
  }
  code = exited === null ? (opt.frames ? 0 : 1) : exited;
} catch (e) {
  console.error("web_run:", e.message);
  code = 1;
}
done(code);
