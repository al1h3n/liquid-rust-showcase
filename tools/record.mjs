// Records the showcase frame by frame: headless Chrome over the DevTools protocol,
// a deterministic clock in the page (`?record`), PNG frames piped into ffmpeg.
// No npm dependencies: Node 22+ (global WebSocket), Chrome or Edge, ffmpeg on PATH.
//
//   node tools/record.mjs                         # media/showcase.mp4, 1920×1080 @ 60 fps
//   node tools/record.mjs --seconds 6 --out media/clip.mp4
//   node tools/record.mjs --stills 3,9.2,17 --out media/stills   # PNGs at those times
//   node tools/record.mjs --theme dark --stills 0 --out media/dark

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : acc), []),
);
const width = Number(args.width ?? 1920), height = Number(args.height ?? 1080);
const fps = Number(args.fps ?? 60);
const seconds = Number(args.seconds ?? 28);
const scale = Number(args.dpr ?? 1);
const stills = args.stills ? String(args.stills).split(",").map(Number) : null;
const out = resolve(root, args.out ?? (stills ? "media/stills" : "media/showcase.mp4"));
const query = new URLSearchParams({ record: "1", dpr: String(scale), theme: args.theme ?? "light" });

// --- static server for the repo
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png", ".mp4": "video/mp4", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(root) || !existsSync(path) || path.endsWith("\\") || path.endsWith("/")) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/www/index.html?${query}`;

// --- Chrome
const chromes = [
  args.chrome,
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chromePath = chromes.find((p) => existsSync(p));
if (!chromePath) throw new Error("Chrome not found; pass --chrome <path>");
const profile = mkdtempSync(join(tmpdir(), "lr-record-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  args.headed ? "--window-position=0,0" : "--headless=new",
  `--window-size=${width},${height}`,
  "--enable-unsafe-webgpu",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--hide-scrollbars",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "about:blank",
], { stdio: "ignore" });

let target;
for (let i = 0; i < 100 && !target; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("could not reach Chrome's DevTools endpoint");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
  if (msg.method === "Runtime.consoleAPICalled" && args.verbose) console.log("[page]", ...msg.params.args.map((a) => a.value ?? a.description));
  if (msg.method === "Runtime.exceptionThrown") console.error("[page error]", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++nextId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
await send("Page.navigate", { url });

for (let i = 0; ; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await evaluate("window.__ready === true").catch(() => false)) break;
  if (i > 150) throw new Error("page never became ready (is WebGPU available headless? try --headed)");
}
console.log(`recording ${url} at ${width}×${height}, ${fps} fps`);

const shot = async () => Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64");
const dt = 1 / fps;
let t = 0;
const stepTo = async (time) => {
  while (t + dt / 2 < time) {
    await evaluate(`window.__step(${dt})`);
    t += dt;
  }
};

if (stills) {
  mkdirSync(out, { recursive: true });
  for (const s of [...stills].sort((a, b) => a - b)) {
    await stepTo(s);
    await evaluate(`window.__step(0)`);
    const file = join(out, `t${s.toFixed(2).replace(".", "_")}.png`);
    writeFileSync(file, await shot());
    console.log("wrote", file);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  const ffmpeg = spawn("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
    "-vf", `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation",
    "-movflags", "+faststart", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.round(seconds * fps);
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await evaluate(`window.__step(${i === 0 ? 0 : dt})`);
    const png = await shot();
    if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % fps === 0) process.stdout.write(`\r${(i / fps).toFixed(0)}s / ${seconds}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.once("close", r));
  console.log(`\nwrote ${out}`);
}

ws.close();
chrome.kill();
server.close();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(profile, { recursive: true, force: true }); } catch {}
