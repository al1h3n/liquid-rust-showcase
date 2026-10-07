// LiquidRust showcase.
//
// Three layers, bottom to top:
//   back  (2D canvas, offscreen): background, title, captions and the slider/toggle fills.
//         Uploaded to liquid-rust as the content the glass refracts.
//   glass (WebGPU canvas): liquid-rust draws content + every glass shape.
//   ink   (2D canvas): glyphs and labels sitting on the glass, plus the scripted cursors.
//
// Scene units are "world" units: the 1600×900 design scaled to fit the window
// (landscape) or a 440×956 design (portrait). Pixels per unit = devicePixelRatio × fit.

import init, { Showcase } from "./pkg/liquid_rust_showcase.js";

const params = new URLSearchParams(location.search);
const RECORD = params.has("record");
// System accessibility settings seed the panel (`?nomedia` ignores them, as the recorder does).
const media = (q) => !RECORD && !params.has("nomedia") && matchMedia(q).matches;

// ---------------------------------------------------------------- palette

const COLORS = {
  light: {
    bgTop: "#DCDEE3", bgBottom: "#CDD0D6", glow: "rgba(255,255,255,0.7)",
    guide: "rgba(60,60,67,0.17)", title: "#1D1D1F", label: "#1D1D1F", secondary: "#6E6E73",
    tertiary: "#8E8E93", track: "#C4C7CE", green: "#34C759", blue: "#0088FF",
    fill: "rgba(120,120,128,0.14)", fillPressed: "rgba(120,120,128,0.26)",
  },
  dark: {
    bgTop: "#141518", bgBottom: "#0B0C0E", glow: "rgba(120,130,255,0.10)",
    guide: "rgba(235,235,245,0.11)", title: "#F5F5F7", label: "#F5F5F7", secondary: "#98989D",
    tertiary: "#7C7C80", track: "#2A2B2F", green: "#30D158", blue: "#0A84FF",
    fill: "rgba(120,120,128,0.30)", fillPressed: "rgba(120,120,128,0.45)",
  },
};
const HUES = ["#1FA2FF", "#3B6DF6", "#6E4BDC", "#A43FD0", "#E0389B", "#FF3B5C", "#FF6A2B", "#FFA51F", "#FFD21F"];
const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Consolas, monospace";
const SERIF = "'Instrument Serif', 'Times New Roman', serif";
const LOOP = 28; // seconds in one autoplay loop

// ---------------------------------------------------------------- helpers

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
const mixHex = (a, b, t) => toHex(rgb(a).map((v, i) => lerp(v, rgb(b)[i], t)));
const mixRgba = (a, b, t) => {
  const p = (s) => s.match(/[\d.]+/g).map(Number);
  const [x, y] = [p(a), p(b)];
  return `rgba(${x.slice(0, 3).map((v, i) => Math.round(lerp(v, y[i], t))).join(",")},${lerp(x[3], y[3], t).toFixed(3)})`;
};
const color = (key) => {
  const a = COLORS.light[key], b = COLORS.dark[key], t = S.darkT;
  if (t <= 0) return a;
  if (t >= 1) return b;
  return a.startsWith("#") ? mixHex(a, b, t) : mixRgba(a, b, t);
};
const inside = (p, r, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const hueAt = (t) => {
  const f = clamp(t) * (HUES.length - 1), i = Math.min(HUES.length - 2, Math.floor(f));
  return mixHex(HUES[i], HUES[i + 1], f - i);
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// ---------------------------------------------------------------- state

const S = {
  dark: params.get("theme") ? params.get("theme") === "dark" : media("(prefers-color-scheme: dark)"),
  darkT: 0,
  transparency: media("(prefers-reduced-transparency: reduce)") ? 1 : 0.5,
  contrast: media("(prefers-contrast: more)"),
  reduceTransparency: false,
  reduceMotion: media("(prefers-reduced-motion: reduce)"),
  physics: true,
  merge: true,
  refraction: 0.7,
  hue: 0.84,
  lensMaterial: "clear",
  lensShown: true,
  menuOpen: false,
  lightSweep: 0,
  autoplay: true,
};
S.darkT = S.dark ? 1 : 0;

let gl;           // Showcase (wasm)
let W, H, dpr, fit, portrait, L; // viewport, layout
let simTime = 0;
const E = {};     // glass handles
const C = {};     // container handles
const back = document.createElement("canvas");
const bctx = back.getContext("2d");
const glassCanvas = document.getElementById("glass");
const ink = document.getElementById("ink");
const ictx = ink.getContext("2d");

// ---------------------------------------------------------------- layout

function measureViewport() {
  // A hidden tab can report a 0×0 viewport; lay out for something sane until resize.
  const cw = innerWidth || 1600, ch = innerHeight || 900;
  dpr = RECORD ? Number(params.get("dpr") ?? 1) : Math.min(devicePixelRatio || 1, 2);
  portrait = cw / ch < 0.9;
  const dw = portrait ? 440 : 1600, dh = portrait ? 956 : 900;
  fit = Math.min(cw / dw, ch / dh);
  W = cw / fit;
  H = ch / fit;
  for (const c of [back, glassCanvas, ink]) {
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
  }
  L = portrait ? portraitLayout(W, H) : landscapeLayout(W, H);
}

// Landscape: the design is 1600×900; things that bleed off an edge stay pinned to it.
function landscapeLayout(W, H) {
  const ox = (W - 1600) / 2, oy = (H - 900) / 2;
  const cx = (x) => x + ox, cy = (y) => y + oy;
  const right = (x) => W - (1600 - x), bottom = (y) => H - (900 - y);
  const r = (x, y, w, h) => ({ x, y, w, h });
  const track = r(cx(300), cy(160), 190, 84);
  const knob = { w: 132, h: 104 };
  const refTrack = r(-40, bottom(748), cx(460) + 40, 28);
  const hueBar = r(right(1040), cy(198), W - right(1040) + 40, 72);
  const plus = r(cx(756), cy(612), 88, 88);
  return {
    portrait: false,
    title: { x: cx(800), y: cy(466), size: 196 },
    subtitle: { x: cx(800), y: cy(538), size: 20 },
    slab: r(-70, -96, cx(330), 404),
    track,
    knobOn: r(track.x + track.w + 16 - knob.w, track.y + track.h / 2 - knob.h / 2, knob.w, knob.h),
    knobOff: r(track.x - 16, track.y + track.h / 2 - knob.h / 2, knob.w, knob.h),
    trackCaption: { x: track.x + track.w + 46, y: track.y + track.h / 2 - 4 },
    refTrack,
    refKnob: { w: 118, h: 78, y: refTrack.y + refTrack.h / 2, min: 64, max: cx(400) },
    refCaption: { x: 40, y: refTrack.y - 52 },
    hueBar,
    hueKnob: { w: 128, h: 128, y: hueBar.y + hueBar.h / 2, min: right(1110), max: right(1548) },
    hueCaption: { x: hueBar.x - 30, y: hueBar.y + hueBar.h / 2 - 4, align: "right" },
    pairA: r(right(1006), cy(120), 244, 104),
    pairB: r(right(1262), cy(120), 104, 104),
    pairShift: 46,
    pairSpacing: 40,
    toolbar: [0, 1, 2].map((i) => r(right(1210) + i * 58, 36, 52, 52)),
    cta: r(right(1400), 36, 176, 52),
    toast: r(cx(800) - 186, 36, 372, 52),
    plus,
    menu: r(plus.x - 20 - 236, cy(540), 236, 214),
    panel: r(right(1120), bottom(560), W - right(1120) + 80, 420),
    lensHome: r(cx(262) - 88, cy(420) - 88, 176, 176),
    park: [{ x: cx(560), y: cy(250) }, { x: cx(150), y: cy(590) }, { x: right(1030), y: bottom(800) }],
  };
}

// Portrait: a 440-wide phone column, same parts stacked.
function portraitLayout(W, H) {
  const ox = (W - 440) / 2, oy = (H - 956) / 2;
  const cx = (x) => x + ox, cy = (y) => y + oy;
  const r = (x, y, w, h) => ({ x, y, w, h });
  const track = r(cx(48), cy(150), 120, 56);
  const knob = { w: 88, h: 70 };
  const refTrack = r(-30, cy(640), cx(300) + 30, 20);
  const hueBar = r(cx(150), cy(500), W - cx(150) + 30, 48);
  const plus = r(cx(40), cy(724), 64, 64);
  return {
    portrait: true,
    title: { x: cx(220), y: cy(356), size: 92 },
    subtitle: { x: cx(220), y: cy(396), size: 15 },
    slab: r(cx(280), -80, W - cx(280) + 60, 200),
    track,
    knobOn: r(track.x + track.w + 10 - knob.w, track.y + track.h / 2 - knob.h / 2, knob.w, knob.h),
    knobOff: r(track.x - 10, track.y + track.h / 2 - knob.h / 2, knob.w, knob.h),
    trackCaption: { x: track.x, y: track.y + track.h + 40 },
    refTrack,
    refKnob: { w: 84, h: 56, y: refTrack.y + refTrack.h / 2, min: cx(50), max: cx(270) },
    refCaption: { x: cx(24), y: refTrack.y - 40 },
    hueBar,
    hueKnob: { w: 84, h: 84, y: hueBar.y + hueBar.h / 2, min: cx(190), max: cx(392) },
    hueCaption: { x: cx(170), y: hueBar.y - 40 },
    pairA: r(cx(206), cy(146), 136, 64),
    pairB: r(cx(350), cy(146), 64, 64),
    pairShift: 34,
    pairSpacing: 28,
    toolbar: [0, 1, 2].map((i) => r(cx(20) + i * 50, cy(28), 44, 44)),
    cta: r(cx(276), cy(28), 144, 44),
    toast: r(cx(220) - 150, cy(84), 300, 46),
    plus,
    menu: r(plus.x, plus.y - 16 - 200, 220, 200),
    panel: r(cx(124), cy(700), W - cx(124) + 40, 300),
    lensHome: r(cx(70) - 60, cy(484) - 60, 120, 120),
    park: [{ x: cx(250), y: cy(250) }, { x: cx(60), y: cy(580) }, { x: cx(80), y: cy(880) }],
  };
}

const knobRect = (k, cxv) => ({ x: cxv - k.w / 2, y: k.y - k.h / 2, w: k.w, h: k.h });
const refCenter = () => lerp(L.refKnob.min, L.refKnob.max, S.refraction);
const hueCenter = () => lerp(L.hueKnob.min, L.hueKnob.max, S.hue);
const pairBAt = (apart) => ({ ...L.pairB, x: L.pairB.x + (apart ? L.pairShift : 0) });

// ---------------------------------------------------------------- scene

const add = (r, shape, radius, material, { tint = 0, interactive = false, lens = false, container = -1, z = 0, smoothing = 0.6 } = {}) =>
  gl.add(r.x, r.y, r.w, r.h, shape, radius, smoothing, material, tint, interactive, lens, container, z);
const setFrame = (id, r, d, b) => (d === undefined ? gl.setFrame(id, r.x, r.y, r.w, r.h) : gl.setFrameWith(id, r.x, r.y, r.w, r.h, d, b));
const frameOf = (id) => {
  const f = id === undefined ? undefined : gl.frameOf(id);
  return f ? { x: f[0], y: f[1], w: f[2], h: f[3] } : null;
};

function buildScene() {
  C.pair = gl.addContainer(L.pairSpacing, 0);
  C.tool = gl.addContainer(14, 0);
  C.plus = gl.addContainer(18, 1);

  E.slab = add(L.slab, "rounded", L.portrait ? 40 : 64, "regular");
  E.panel = add(L.panel, "rounded", L.portrait ? 34 : 48, "regular");
  E.knob = add(S.merge ? L.knobOn : L.knobOff, "capsule", 0, "clear", { interactive: true });
  E.pairA = add(L.pairA, "capsule", 0, "clear", { container: C.pair });
  E.pairB = add(L.pairB, "capsule", 0, "clear", { container: C.pair });
  E.refKnob = add(knobRect(L.refKnob, refCenter()), "capsule", 0, "clear", { lens: true, z: 1 });
  E.hueKnob = add(knobRect(L.hueKnob, hueCenter()), "capsule", 0, "clear", { lens: true, z: 1 });
  E.tools = L.toolbar.map((r) => add(r, "capsule", 0, "regular", { interactive: true, container: C.tool }));
  E.cta = add(L.cta, "capsule", 0, "tinted", { tint: parseInt(hueAt(S.hue).slice(1), 16), interactive: true });
  E.plus = add(L.plus, "capsule", 0, "regular", { interactive: true, container: C.plus });
  E.lens = add(L.lensHome, "capsule", 0, "clear", { lens: true, z: 2 });
  E.menu = undefined;
  E.toast = undefined;
  applyLensMaterial();
  applyAppearance();
}

function applyLensMaterial() {
  if (E.lens === undefined) return;
  const tint = parseInt(hueAt(S.hue).slice(1), 16);
  // Refraction slider drives Figma's Refraction and Depth knobs on the lens.
  gl.setMaterial(E.lens, S.lensMaterial, tint, 0.85, S.refraction, 12 + 40 * S.refraction, NaN, NaN);
}

function applyCtaTint() {
  gl.setMaterial(E.cta, "tinted", parseInt(hueAt(S.hue).slice(1), 16), NaN, NaN, NaN, NaN, NaN);
  if (S.lensMaterial === "tinted") applyLensMaterial();
}

function applyAppearance() {
  gl.setAppearance(S.transparency, S.dark, S.reduceTransparency, S.contrast, S.reduceMotion);
  gl.setPhysics(S.physics);
  document.documentElement.dataset.theme = S.dark ? "dark" : "light";
}

function setMerge(on) {
  S.merge = on;
  gl.setContainerSpacing(C.pair, on ? L.pairSpacing : 0);
  const from = on ? L.knobOff : L.knobOn, to = on ? L.knobOn : L.knobOff;
  // The knob stretches toward where it is going, then settles with a bounce.
  const reach = Math.abs(to.x - from.x) * 0.6;
  const stretched = on ? { ...from, w: from.w + reach } : { ...from, x: from.x - reach, w: from.w + reach };
  setFrame(E.knob, stretched, 0.16, 0);
  after(0.11, () => setFrame(E.knob, to, 0.5, 0.32));
}

function toggleMenu(open = !S.menuOpen) {
  if (open === S.menuOpen) return;
  S.menuOpen = open;
  if (open) {
    const m = L.menu;
    E.menu = gl.expandFrom(E.plus, m.x, m.y, m.w, m.h, "rounded", 28, "regular", 0.5, 0.22);
    menuOpenedAt = simTime;
  } else if (E.menu !== undefined) {
    gl.collapseInto(E.menu, E.plus, 0.38, 0);
    closingMenu = E.menu;
    E.menu = undefined;
  }
}
let menuOpenedAt = -10, closingMenu;

const MENU_ROWS = [
  { key: "clear", label: "Clear glass" },
  { key: "regular", label: "Regular glass" },
  { key: "tinted", label: "Tinted glass" },
  { key: "hide", label: "Hide lens" },
];

function chooseMenu(key) {
  if (key === "hide") {
    if (S.lensShown) gl.remove(E.lens);
    else {
      E.lens = add(L.lensHome, "capsule", 0, S.lensMaterial, { lens: true, z: 2 });
      applyLensMaterial();
    }
    S.lensShown = !S.lensShown;
  } else {
    S.lensMaterial = key;
    applyLensMaterial();
  }
  after(0.28, () => toggleMenu(false));
}

let toastAt = -10, toastGoneAt = -10, toastText = "", toastOk = true;
function showToast(text, ok = true) {
  toastText = text;
  toastOk = ok;
  if (E.toast !== undefined) return;
  E.toast = add(L.toast, "capsule", 0, "regular", { z: 3 });
  toastAt = simTime;
  after(2.2, () => {
    gl.remove(E.toast);
    E.toast = undefined;
    toastGoneAt = simTime;
  });
}

const INSTALL = "cargo add liquid-rust";
let copyPending = false;

function activate(id, ptr) {
  if (id === E.knob) setMerge(!S.merge);
  else if (id === E.plus) toggleMenu();
  else if (id === E.tools[0]) S.lightSweep += 120;
  else if (id === E.tools[1]) (S.autoplay ? stopAutoplay() : startAutoplay());
  else if (id === E.tools[2]) resetAll();
  else if (id === E.cta) {
    // A real click copies (in the click handler below, where browsers allow it);
    // a scripted cursor only shows what would happen.
    if (ptr === mouse) copyPending = true;
    else showToast(`Copied “${INSTALL}”`);
  }
}

function resetAll() {
  toggleMenu(false);
  if (!S.merge) setMerge(true);
  S.refraction = 0.7;
  S.hue = 0.84;
  S.lensMaterial = "clear";
  if (!S.lensShown) {
    E.lens = add(L.lensHome, "capsule", 0, "clear", { lens: true, z: 2 });
    S.lensShown = true;
  }
  setFrame(E.lens, L.lensHome, 0.6, 0.15);
  setFrame(E.refKnob, knobRect(L.refKnob, refCenter()), 0.6, 0.15);
  setFrame(E.hueKnob, knobRect(L.hueKnob, hueCenter()), 0.6, 0.15);
  Object.assign(S, { transparency: 0.5, contrast: false, reduceTransparency: false, physics: true });
  if (S.dark) S.dark = false;
  applyCtaTint();
  applyLensMaterial();
  applyAppearance();
}

// ---------------------------------------------------------------- appearance panel (fills on glass)

const CHIPS = [
  { key: "dark", label: "Dark" },
  { key: "contrast", label: "More Contrast" },
  { key: "reduceMotion", label: "Reduce Motion" },
  { key: "reduceTransparency", label: "Reduce Transparency" },
  { key: "physics", label: "Physics" },
];

function panelUI() {
  const pf = frameOf(E.panel) ?? L.panel;
  const pad = L.portrait ? 20 : 28;
  const x = pf.x + pad, x1 = Math.min(pf.x + pf.w, W) - pad;
  const y = pf.y + pad;
  const small = L.portrait;
  const ui = {
    header: { x, y: y + (small ? 18 : 22) },
    sub: { x, y: y + (small ? 38 : 46) },
    slider: { x0: x, x1, y: y + (small ? 76 : 100) },
    chips: [],
  };
  ictx.font = `500 ${small ? 13 : 14}px ${FONT}`;
  let cxp = x, cyp = y + (small ? 108 : 150);
  const h = small ? 32 : 36, gap = 8;
  for (const chip of CHIPS) {
    const w = ictx.measureText(chip.label).width + (small ? 24 : 30);
    if (cxp + w > x1 && cxp > x) { cxp = x; cyp += h + gap; }
    ui.chips.push({ ...chip, x: cxp, y: cyp, w, h });
    cxp += w + gap;
  }
  return ui;
}

function setTransparencyFrom(p) {
  const s = panelUI().slider;
  S.transparency = clamp((p.x - s.x0 - 19) / (s.x1 - s.x0 - 38));
  applyAppearance();
}

function toggleChip(key) {
  S[key] = !S[key];
  applyAppearance();
}

// ---------------------------------------------------------------- input (real mouse + scripted cursors)

let sceneOwner = null; // liquid-rust tracks one pointer; whoever pressed glass owns it

function pointerDown(ptr, p) {
  ptr.p0 = p;
  ptr.ui = null;
  ptr.glass = -1;
  // Fills on the appearance panel.
  const ui = panelUI();
  const chip = ui.chips.find((c) => inside(p, c, 2));
  if (chip) { ptr.ui = { kind: "chip", chip }; return; }
  const s = ui.slider;
  if (Math.abs(p.y - s.y) < 22 && p.x > s.x0 - 16 && p.x < s.x1 + 16) {
    ptr.ui = { kind: "slider" };
    setTransparencyFrom(p);
    return;
  }
  // Menu rows (fills on the menu glass).
  const mf = E.menu !== undefined && frameOf(E.menu);
  if (mf && inside(p, mf)) {
    const row = menuRowAt(mf, p);
    if (row >= 0) ptr.ui = { kind: "menu", row };
    return;
  }
  // liquid-rust tracks one pointer. The real mouse always gets it; cursors wait their turn.
  if (sceneOwner && sceneOwner !== ptr) {
    if (ptr !== mouse) return;
    abandon(sceneOwner);
  }
  const id = gl.pointerDown(p.x, p.y);
  if (id < 0) {
    if (S.menuOpen && !inside(p, L.plus)) toggleMenu(false);
    return;
  }
  sceneOwner = ptr;
  ptr.glass = id;
  const f = frameOf(id);
  ptr.grab = { x: f.x + f.w / 2 - p.x, y: f.y + f.h / 2 - p.y };
}

function pointerMove(ptr, p) {
  if (ptr.ui?.kind === "slider") return setTransparencyFrom(p);
  if (sceneOwner !== ptr) return;
  if (ptr.glass === E.refKnob || ptr.glass === E.hueKnob) {
    const k = ptr.glass === E.refKnob ? L.refKnob : L.hueKnob;
    const c = clamp(p.x + ptr.grab.x, k.min, k.max);
    gl.pointerMove(c - ptr.grab.x, ptr.p0.y);
    const v = (c - k.min) / (k.max - k.min);
    if (ptr.glass === E.refKnob) { S.refraction = v; applyLensMaterial(); }
    else { S.hue = v; applyCtaTint(); }
  } else if (ptr.glass === E.lens) {
    gl.pointerMove(clamp(p.x, 0, W), clamp(p.y, 0, H));
  } else {
    gl.pointerMove(p.x, p.y);
  }
}

function pointerUp(ptr, p) {
  const ui = ptr.ui;
  ptr.ui = null;
  if (ui?.kind === "chip" && inside(p, ui.chip, 6)) toggleChip(ui.chip.key);
  if (ui?.kind === "menu") {
    const mf = E.menu !== undefined && frameOf(E.menu);
    if (mf && menuRowAt(mf, p) === ui.row) chooseMenu(MENU_ROWS[ui.row].key);
  }
  if (sceneOwner !== ptr) return;
  gl.pointerUp();
  sceneOwner = null;
  const id = ptr.glass;
  ptr.glass = -1;
  const moved = Math.hypot(p.x - ptr.p0.x, p.y - ptr.p0.y);
  if (moved < 12 && gl.hitTest(p.x, p.y) === id) activate(id, ptr);
}

// Lets go of the glass without activating it (the real mouse took over).
function abandon(ptr) {
  if (sceneOwner !== ptr) return;
  gl.pointerUp();
  sceneOwner = null;
  ptr.glass = -1;
}

function menuRowAt(mf, p) {
  const pad = 10, rowH = (L.menu.h - pad * 2) / MENU_ROWS.length;
  const i = Math.floor((p.y - mf.y - pad) / rowH);
  return i >= 0 && i < MENU_ROWS.length ? i : -1;
}

const mouse = { name: "you" };
const toWorld = (e) => ({ x: e.clientX / fit, y: e.clientY / fit });
ink.addEventListener("pointerdown", (e) => {
  if (RECORD || !gl) return;
  ink.setPointerCapture(e.pointerId);
  if (S.autoplay) {
    const p = toWorld(e);
    // The play/pause button keeps working during autoplay; anything else takes over.
    if (!(gl.hitTest(p.x, p.y) === E.tools[1])) stopAutoplay();
  }
  pointerDown(mouse, toWorld(e));
  mouse.down = true;
  wake();
});
ink.addEventListener("pointermove", (e) => {
  if (RECORD || !gl) return;
  const p = toWorld(e);
  mouse.pos = p;
  if (mouse.down) pointerMove(mouse, p);
  else ink.classList.toggle("hot", hoverable(p));
  ink.classList.toggle("grab", mouse.down && sceneOwner === mouse && [E.lens, E.refKnob, E.hueKnob].includes(mouse.glass));
  wake();
});
const release = (e) => {
  if (RECORD || !gl || !mouse.down) return;
  mouse.down = false;
  pointerUp(mouse, toWorld(e));
  ink.classList.remove("grab");
  wake();
};
ink.addEventListener("pointerup", release);
ink.addEventListener("pointercancel", release);
ink.addEventListener("click", () => {
  if (!copyPending) return;
  copyPending = false;
  copyInstall();
});

// Clipboard API first; the textarea + execCommand path covers browsers or embeds
// that refuse it. Both run inside the click, which every browser counts as a gesture.
async function copyInstall() {
  let ok = false;
  try {
    await navigator.clipboard.writeText(INSTALL);
    ok = true;
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: INSTALL, readOnly: true });
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
  }
  showToast(ok ? `Copied “${INSTALL}”` : `Copy blocked: ${INSTALL}`, ok);
  wake();
}

function hoverable(p) {
  if (gl.hitTest(p.x, p.y) >= 0) return true;
  const ui = panelUI();
  if (ui.chips.some((c) => inside(p, c)) || (Math.abs(p.y - ui.slider.y) < 22 && p.x > ui.slider.x0 && p.x < ui.slider.x1)) return true;
  const mf = E.menu !== undefined && frameOf(E.menu);
  return Boolean(mf && inside(p, mf));
}

addEventListener("keydown", (e) => {
  if (RECORD || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const map = { d: "dark", c: "contrast", m: "reduceMotion", t: "reduceTransparency", p: "physics" };
  if (map[k]) toggleChip(map[k]);
  else if (k === " ") { e.preventDefault(); S.autoplay ? stopAutoplay() : startAutoplay(); }
  else if (k === "escape") toggleMenu(false);
  else return;
  wake();
});

// ---------------------------------------------------------------- simulated clock

const timers = [];
const after = (s, fn) => timers.push({ t: simTime + s, fn });
function runTimers() {
  timers.sort((a, b) => a.t - b.t);
  while (timers.length && timers[0].t <= simTime + 1e-6) timers.shift().fn();
}
const CANCEL = Symbol("cancel");
let gen = 0;
const sleepUntil = (t, g) => new Promise((res, rej) => timers.push({ t, fn: () => (g === gen ? res() : rej(CANCEL)) }));

// ---------------------------------------------------------------- scripted cursors

class Cursor {
  constructor(name, tint, park) {
    Object.assign(this, { name, tint, park, pos: { ...park }, down: false, alpha: 0, anim: null, pressT: 0 });
  }
  // Moves along a gentle arc with an ease-in-out, like a hand.
  move(to, dur, g) {
    const from = { ...this.pos };
    const dx = to.x - from.x, dy = to.y - from.y, bend = (this.bend = -(this.bend ?? 1)) * 0.14;
    const ctrl = { x: from.x + dx / 2 - dy * bend, y: from.y + dy / 2 + dx * bend };
    const t0 = simTime;
    this.anim = (t) => {
      const u = ease(clamp((t - t0) / dur));
      const a = 1 - u;
      return { x: a * a * from.x + 2 * a * u * ctrl.x + u * u * to.x, y: a * a * from.y + 2 * a * u * ctrl.y + u * u * to.y };
    };
    return sleepUntil(t0 + dur, g);
  }
  // Catmull-Rom through `points`, sine-eased over `dur`.
  path(points, dur, g) {
    const pts = [{ ...this.pos }, ...points];
    const t0 = simTime;
    this.anim = (t) => {
      const u = easeSine(clamp((t - t0) / dur)) * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(u)), f = u - i;
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
      return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
    };
    return sleepUntil(t0 + dur, g);
  }
  press() { this.down = true; pointerDown(this, { ...this.pos }); }
  release() { this.down = false; pointerUp(this, { ...this.pos }); }
  async tap(g) {
    this.press();
    await sleepUntil(simTime + 0.14, g);
    this.release();
  }
  update(t) {
    if (this.anim) {
      const p = this.anim(t);
      const movedNow = p.x !== this.pos.x || p.y !== this.pos.y;
      this.pos = p;
      if (this.down && movedNow) pointerMove(this, p);
    }
  }
}

const cursors = [
  new Cursor("Ferris", "#F2672A", { x: 0, y: 0 }),
  new Cursor("Ada", "#AF52DE", { x: 0, y: 0 }),
  new Cursor("Grace", "#0088FF", { x: 0, y: 0 }),
];

let loopStart = 0;
const at = (t, g) => sleepUntil(loopStart + t, g);
const glassCenter = (id) => center(frameOf(id));

async function ferris(c, g) {
  await at(0.35, g);
  await c.move(glassCenter(E.knob), 0.55, g);
  await c.tap(g);                                             // Liquid merge off: the pair splits
  await c.move({ x: refCenter() + 70, y: L.refKnob.y - 90 }, 1.4, g);
  await at(6.5, g);
  await c.move({ x: refCenter(), y: L.refKnob.y }, 0.35, g);
  c.press();                                                  // drag the refraction slider
  const k = L.refKnob;
  await c.path([
    { x: lerp(k.min, k.max, 1.0), y: k.y + 2 },
    { x: lerp(k.min, k.max, 0.12), y: k.y - 3 },
    { x: lerp(k.min, k.max, 0.7), y: k.y },
  ], 2.9, g);
  await sleepUntil(simTime + 0.15, g);
  c.release();
  await c.move({ x: L.knobOn.x + 60, y: L.knobOn.y + 140 }, 1.6, g);
  await at(13.4, g);
  await c.move(glassCenter(E.knob), 0.45, g);
  await c.tap(g);                                             // merge back on: they fuse
  await c.move({ x: L.toolbar[0].x - 40, y: L.toolbar[0].y + 110 }, 1.8, g);
  await at(20.5, g);
  for (const when of [20.8, 21.5, 22.2]) {                    // sweep the light around
    await c.move(glassCenter(E.tools[0]), when === 20.8 ? 0.3 : 0.2, g);
    await at(when, g);
    await c.tap(g);
    await c.move({ x: glassCenter(E.tools[0]).x + 10, y: glassCenter(E.tools[0]).y + 26 }, 0.25, g);
  }
  await c.move(glassCenter(E.cta), 0.9, g);
  await at(24.2, g);
  await c.tap(g);                                             // primary action: materializes a toast
  await c.move(c.park, 2.4, g);
  await at(LOOP, g);
}

async function ada(c, g) {
  await at(1.4, g);
  const home = center(L.lensHome);
  await c.move(home, 0.5, g);
  c.press();                                                  // pick up the lens…
  const t = L.title;
  const span = L.portrait ? 150 : 360;
  await c.path([
    { x: t.x - span * 0.95, y: t.y - 60 },
    { x: t.x - span * 0.4, y: t.y - 20 },
    { x: t.x + span * 0.15, y: t.y - 62 },
    { x: t.x + span * 0.7, y: t.y - 30 },
    { x: t.x + span * 1.05, y: t.y - 10 },
  ], 4.1, g);                                                 // …and read the title through it
  await sleepUntil(simTime + 0.12, g);
  c.release();
  await c.move({ x: hueCenter() - 60, y: L.hueKnob.y + 120 }, 2.0, g);
  await at(9.7, g);
  await c.move({ x: hueCenter(), y: L.hueKnob.y }, 0.35, g);
  c.press();                                                  // drag the tint along the gradient
  const k = L.hueKnob;
  await c.path([
    { x: lerp(k.min, k.max, 0.05), y: k.y - 2 },
    { x: lerp(k.min, k.max, 0.45), y: k.y + 3 },
    { x: lerp(k.min, k.max, 0.84), y: k.y },
  ], 2.7, g);
  await sleepUntil(simTime + 0.15, g);
  c.release();
  await c.move({ x: t.x + span * 0.8, y: t.y + 120 }, 2.0, g);
  await at(16.0, g);
  const lens = glassCenter(E.lens);
  await c.move(lens, 0.4, g);
  c.press();                                                  // dark mode pass, over the + button
  const plus = center(L.plus);
  await c.path([
    { x: t.x + span * 0.35, y: t.y - 56 },
    { x: t.x - span * 0.1, y: t.y - 30 },
    { x: plus.x + 20, y: plus.y - 10 },
    { x: plus.x - span * 0.45, y: plus.y - 90 },
    { x: home.x + 40, y: home.y + 10 },
    home,
  ], 4.3, g);
  await sleepUntil(simTime + 0.12, g);
  c.release();
  await c.move(c.park, 2.2, g);
  await at(LOOP, g);
}

async function grace(c, g) {
  const ui = () => panelUI();
  const chip = (key) => center(ui().chips.find((x) => x.key === key));
  const nudge = (p, dx, dy) => ({ x: p.x + dx, y: p.y + dy });
  const sx = (v) => lerp(ui().slider.x0 + 19, ui().slider.x1 - 19, v);
  const knob = (v) => ({ x: sx(v), y: ui().slider.y });
  // Panel controls are fills, not glass: Grace works them while the others hold the glass.
  await at(0.6, g);
  await c.move(chip("contrast"), 1.3, g);
  await at(2.3, g);
  await c.tap(g);                                             // More Contrast while the lens reads the title
  await c.move(nudge(chip("contrast"), 26, 44), 0.8, g);
  await at(4.6, g);
  await c.move(chip("contrast"), 0.4, g);
  await at(5.1, g);
  await c.tap(g);                                             // …and off
  await c.move(knob(S.transparency), 0.9, g);
  await at(6.6, g);
  c.press();                                                  // ultra clear while Ferris tunes refraction
  await c.path([knob(0.3), knob(0.06)], 1.0, g);
  await at(8.6, g);
  await c.path([knob(0.5)], 0.9, g);
  c.release();
  await c.move(chip("physics"), 0.6, g);
  await at(10.4, g);
  await c.tap(g);                                             // Physics off: Ada's knob loses its lift and stretch
  await c.move(nudge(chip("physics"), -30, 40), 0.7, g);
  await at(11.4, g);
  await c.move(chip("physics"), 0.3, g);
  await at(11.8, g);
  await c.tap(g);                                             // …and back on
  await c.move(center(L.plus), 0.9, g);
  await at(13.0, g);
  await c.tap(g);                                             // + grows a menu out of itself
  const row = (i) => {
    const pad = 10, rowH = (L.menu.h - pad * 2) / MENU_ROWS.length;
    return { x: L.menu.x + L.menu.w * 0.4, y: L.menu.y + pad + rowH * (i + 0.5) };
  };
  await c.move(row(2), 0.6, g);
  await at(14.3, g);
  await c.tap(g);                                             // Tinted glass
  await c.move(chip("dark"), 1.0, g);
  await at(15.8, g);
  await c.tap(g);                                             // Dark
  await c.move(chip("reduceTransparency"), 0.8, g);
  await at(17.2, g);
  await c.tap(g);                                             // Reduce Transparency: frosted, dark glass
  await c.move(nudge(chip("reduceTransparency"), 40, 40), 0.9, g);
  await at(18.8, g);
  await c.move(chip("reduceTransparency"), 0.3, g);
  await at(19.2, g);
  await c.tap(g);                                             // …and clear again
  await at(20.2, g);
  const s = ui().slider;
  await c.move({ x: sx(S.transparency), y: s.y }, 0.5, g);
  c.press();                                                  // iOS 27 transparency slider
  await c.path([
    { x: sx(0), y: s.y + 1 },
    { x: sx(1), y: s.y - 1 },
    { x: sx(0.5), y: s.y },
  ], 2.4, g);
  c.release();
  await c.move(chip("dark"), 0.5, g);
  await at(23.7, g);
  await c.tap(g);                                             // back to light
  await c.move(center(L.plus), 1.0, g);
  await at(25.0, g);
  await c.tap(g);
  await c.move(row(0), 0.55, g);
  await at(25.9, g);
  await c.tap(g);                                             // Clear glass
  await c.move(c.park, 1.5, g);
  await at(LOOP, g);
}

async function ambient(g) {
  // The pair drifts apart and back: past half the spacing the neck pinches off.
  for (let i = 1; i <= 8; i++) {
    await at(i * 3.5 - 1.6, g);
    setFrame(E.pairB, pairBAt(i % 2 === 1), 1.1, 0.12);
  }
  await at(LOOP, g);
}

async function autoplay(g) {
  try {
    for (;;) {
      loopStart = simTime;
      await Promise.all([ferris(cursors[0], g), ada(cursors[1], g), grace(cursors[2], g), ambient(g)]);
      setFrame(E.lens, L.lensHome, 0.4, 0);
    }
  } catch (e) {
    if (e !== CANCEL) throw e;
  }
}

function startAutoplay() {
  resetAll();
  S.autoplay = true;
  gen++;
  cursors.forEach((c, i) => {
    c.park = L.park[i];
    c.pos = { ...c.park };
    c.anim = null;
    c.down = false;
  });
  autoplay(gen);
  wake();
}

function stopAutoplay() {
  S.autoplay = false;
  gen++;
  for (const c of cursors) {
    if (c.down) c.release();
    c.anim = null;
  }
  wake();
}

// ---------------------------------------------------------------- drawing: content behind the glass

function drawBack() {
  const ctx = bctx;
  const k = dpr * fit;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const hair = 1 / k;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, color("bgTop"));
  bg.addColorStop(1, color("bgBottom"));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.12, H * 1.02, 0, W * 0.12, H * 1.02, Math.max(W, H) * 0.62);
  glow.addColorStop(0, color("glow"));
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  drawGuides(ctx, hair);

  // Title and line under it.
  const t = L.title;
  ctx.fillStyle = color("title");
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `400 ${t.size}px ${SERIF}`;
  ctx.letterSpacing = `${-t.size * 0.012}px`;
  ctx.fillText("LiquidRust", t.x, t.y);
  ctx.letterSpacing = "0px";
  ctx.font = `400 ${L.subtitle.size}px ${FONT}`;
  ctx.fillStyle = color("secondary");
  ctx.fillText("Apple’s Liquid Glass for wgpu. Native, and in your browser.", L.subtitle.x, L.subtitle.y);

  // Liquid merge switch: the track colour follows the knob.
  const kf = frameOf(E.knob) ?? L.knobOn;
  const on = clamp((kf.x + kf.w / 2 - center(L.knobOff).x) / (center(L.knobOn).x - center(L.knobOff).x));
  pill(ctx, L.track, mixHex(color("track"), color("green"), on));

  // Refraction slider.
  const rt = L.refTrack, rk = frameOf(E.refKnob);
  pill(ctx, rt, color("track"));
  const rEnd = rk ? rk.x + rk.w / 2 : refCenter();
  pill(ctx, { ...rt, w: rEnd - rt.x }, color("blue"));

  // Tint slider: a spectrum filled up to the knob.
  const hb = L.hueBar, hk = frameOf(E.hueKnob);
  pill(ctx, hb, color("track"));
  const grad = ctx.createLinearGradient(L.hueKnob.min, 0, L.hueKnob.max, 0);
  HUES.forEach((h, i) => grad.addColorStop(i / (HUES.length - 1), h));
  const hEnd = hk ? hk.x + hk.w / 2 : hueCenter();
  pill(ctx, { ...hb, w: hEnd - hb.x }, grad);

  // Captions: what each control is, and the call behind it.
  caption(ctx, L.trackCaption, "Liquid merge", `set_container_spacing(${S.merge ? L.pairSpacing : 0})`);
  caption(ctx, L.refCaption, `Refraction ${S.refraction.toFixed(2)}`, "Material { refraction, depth }");
  caption(ctx, L.hueCaption, "Tint", "Material::tinted(color)");
}

function pill(ctx, r, fill) {
  if (r.w <= 0) return;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(r.h, r.w) / 2);
  ctx.fill();
}

function caption(ctx, at, label, code) {
  ctx.textAlign = at.align ?? "left";
  ctx.font = `600 ${L.portrait ? 13 : 15}px ${FONT}`;
  ctx.fillStyle = color("label");
  ctx.fillText(label, at.x, at.y);
  ctx.font = `400 ${L.portrait ? 11 : 12.5}px ${MONO}`;
  ctx.fillStyle = color("tertiary");
  ctx.fillText(code, at.x, at.y + (L.portrait ? 17 : 21));
}

// Construction lines like a spec sheet; the glass refracts them, which shows the lensing.
function drawGuides(ctx, hair) {
  ctx.strokeStyle = color("guide");
  ctx.lineWidth = hair;
  const circle = (c, r) => { ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke(); };
  const line = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  const s = L.portrait ? 0.6 : 1;

  const slab = L.slab, sc = { x: slab.x + slab.w * 0.42, y: slab.y + slab.h * 0.7 };
  circle(sc, 150 * s); circle(sc, 72 * s);
  line({ x: slab.x, y: slab.y + 40 }, { x: slab.x + slab.w + 40 * s, y: slab.y + slab.h + 60 * s });

  for (const r of [L.knobOn, L.knobOff]) circle(center(r), r.h * 0.62);
  const tc = center(L.track);
  line({ x: L.track.x - 80 * s, y: tc.y }, { x: L.track.x + L.track.w + 120 * s, y: tc.y });
  circle(center(L.knobOn), L.knobOn.h * 0.95);

  const a = center(L.pairA), b = center(L.pairB);
  circle({ x: L.pairA.x + L.pairA.h / 2, y: a.y }, L.pairA.h * 0.66);
  circle(b, L.pairB.h * 0.66);
  circle({ x: hueCenter(), y: L.hueKnob.y }, L.hueKnob.h * 0.72);
  line({ x: L.pairA.x - 60 * s, y: a.y }, { x: W, y: a.y });
  line({ x: b.x, y: L.pairB.y - 60 * s }, { x: b.x, y: L.hueBar.y + L.hueBar.h + 60 * s });

  const p = center(L.plus);
  circle(p, L.plus.w * 0.82);
  line({ x: p.x - 150 * s, y: p.y }, { x: p.x + 150 * s, y: p.y });
  line({ x: p.x, y: p.y - 110 * s }, { x: p.x, y: p.y + 110 * s });

  const lh = center(L.lensHome);
  circle(lh, L.lensHome.w * 0.62);
  line({ x: lh.x - L.lensHome.w, y: lh.y + L.lensHome.w }, { x: lh.x + L.lensHome.w, y: lh.y - L.lensHome.w });

  const rc = { x: refCenter(), y: L.refKnob.y };
  circle(rc, L.refKnob.h * 0.62);
  line({ x: rc.x, y: rc.y - 100 * s }, { x: rc.x, y: rc.y + 100 * s });

  const pf = L.panel, pc = { x: pf.x + pf.w * 0.32, y: pf.y + pf.h * 0.5 };
  circle(pc, 170 * s); circle(pc, 90 * s);
  line({ x: pf.x - 40 * s, y: pf.y - 40 * s }, { x: pf.x + pf.w, y: pf.y + pf.h });
}

// ---------------------------------------------------------------- drawing: ink on the glass + cursors

function drawInk() {
  const ctx = ictx;
  const k = dpr * fit;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const label = color("label");

  // + button.
  const pf = frameOf(E.plus);
  if (pf) {
    const c = center(pf), r = pf.w * 0.19;
    ctx.strokeStyle = label;
    ctx.lineWidth = L.portrait ? 2.6 : 3.4;
    stroke(ctx, [[c.x - r, c.y], [c.x + r, c.y]]);
    stroke(ctx, [[c.x, c.y - r], [c.x, c.y + r]]);
  }

  // Toolbar: light sweep, autoplay, reset.
  E.tools.forEach((id, i) => {
    const f = frameOf(id);
    if (!f) return;
    const c = center(f), u = f.w / 52;
    ctx.strokeStyle = ctx.fillStyle = label;
    ctx.lineWidth = 2 * u;
    if (i === 0) {
      ctx.beginPath(); ctx.arc(c.x, c.y, 5 * u, 0, Math.PI * 2); ctx.stroke();
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4 + (S.lightSweep * Math.PI) / 180;
        stroke(ctx, [[c.x + Math.cos(ang) * 9 * u, c.y + Math.sin(ang) * 9 * u], [c.x + Math.cos(ang) * 12 * u, c.y + Math.sin(ang) * 12 * u]]);
      }
    } else if (i === 1) {
      if (S.autoplay) {
        ctx.fillRect(c.x - 6 * u, c.y - 7.5 * u, 4 * u, 15 * u);
        ctx.fillRect(c.x + 2 * u, c.y - 7.5 * u, 4 * u, 15 * u);
      } else {
        ctx.beginPath(); ctx.moveTo(c.x - 4.5 * u, c.y - 8 * u); ctx.lineTo(c.x + 8 * u, c.y); ctx.lineTo(c.x - 4.5 * u, c.y + 8 * u); ctx.closePath(); ctx.fill();
      }
    } else {
      ctx.beginPath(); ctx.arc(c.x, c.y, 8 * u, -Math.PI * 0.35, Math.PI * 1.45); ctx.stroke();
      const a = -Math.PI * 0.35, tip = { x: c.x + Math.cos(a) * 8 * u, y: c.y + Math.sin(a) * 8 * u };
      stroke(ctx, [[tip.x - 5 * u, tip.y - 1 * u], [tip.x + 0.5 * u, tip.y], [tip.x + 0.5 * u, tip.y - 5.5 * u]]);
    }
  });

  // Primary action label. Stained glass takes its lightness from the backdrop, so over
  // the light page the tint is pale and needs a dark label; in dark mode, white.
  const cf = frameOf(E.cta);
  if (cf) {
    const tint = hueAt(S.hue);
    ctx.fillStyle = S.darkT > 0.5 || luminance(tint) < 0.08 ? "#FFFFFF" : "#1D1D1F";
    ctx.font = `600 ${L.portrait ? 15 : 17}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Add to Cargo", cf.x + cf.w / 2, cf.y + cf.h / 2 + 1);
  }

  drawMenu(ctx, label);
  drawPanel(ctx, label);
  drawToast(ctx, label);
  if (S.autoplay || cursors.some((c) => c.alpha > 0.01)) drawCursors(ctx);
}

function stroke(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function drawMenu(ctx, label) {
  const id = E.menu ?? closingMenu;
  const mf = id !== undefined && frameOf(id);
  if (!mf) return;
  const m = L.menu;
  const grow = clamp((mf.h - L.plus.h) / (m.h - L.plus.h));
  const alpha = E.menu !== undefined ? clamp((simTime - menuOpenedAt - 0.12) / 0.2) * grow : grow ** 3 * 0.8;
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(mf.x, mf.y, mf.w, mf.h, 28);
  ctx.clip();
  const pad = 10, rowH = (m.h - pad * 2) / MENU_ROWS.length;
  const pressedRow = [mouse, ...cursors].find((p) => p.ui?.kind === "menu")?.ui.row;
  MENU_ROWS.forEach((row, i) => {
    const y = mf.y + pad + rowH * i;
    if (i === pressedRow) {
      ctx.fillStyle = color("fillPressed");
      ctx.beginPath(); ctx.roundRect(mf.x + 8, y + 2, mf.w - 16, rowH - 4, 14); ctx.fill();
    }
    const cy = y + rowH / 2, ix = mf.x + 30;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = ctx.fillStyle = label;
    ctx.beginPath(); ctx.arc(ix, cy, 8.5, 0, Math.PI * 2);
    if (row.key === "clear") ctx.stroke();
    else if (row.key === "regular") { ctx.fillStyle = color("fillPressed"); ctx.fill(); ctx.stroke(); }
    else if (row.key === "tinted") { ctx.fillStyle = hueAt(S.hue); ctx.fill(); }
    else { ctx.stroke(); stroke(ctx, [[ix - 6, cy + 6], [ix + 6, cy - 6]]); }
    ctx.fillStyle = label;
    ctx.font = `400 ${L.portrait ? 15 : 16}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const text = row.key === "hide" ? (S.lensShown ? "Hide lens" : "Show lens") : row.label;
    ctx.fillText(text, mf.x + 52, cy + 1);
    if (row.key === S.lensMaterial) {
      ctx.strokeStyle = color("blue");
      ctx.lineWidth = 2.2;
      const x = mf.x + mf.w - 30;
      stroke(ctx, [[x - 6, cy], [x - 1.5, cy + 4.5], [x + 6, cy - 5]]);
    }
    if (i === 2) {
      ctx.fillStyle = color("guide");
      ctx.fillRect(mf.x + 52, y + rowH - 0.5, mf.w - 64, 1);
    }
  });
  ctx.restore();
}

function drawPanel(ctx, label) {
  const ui = panelUI();
  const small = L.portrait;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = label;
  ctx.font = `600 ${small ? 18 : 22}px ${FONT}`;
  ctx.fillText("Appearance", ui.header.x, ui.header.y);
  ctx.fillStyle = color("secondary");
  ctx.font = `400 ${small ? 12 : 14}px ${FONT}`;
  ctx.fillText("Applies to every piece of glass on the page.", ui.sub.x, ui.sub.y);

  // iOS 27 transparency slider, as a fill on the glass.
  const s = ui.slider, v = S.transparency;
  ctx.font = `500 ${small ? 12 : 13}px ${FONT}`;
  ctx.fillStyle = color("secondary");
  ctx.fillText("Clear", s.x0, s.y - 16);
  ctx.textAlign = "right";
  ctx.fillText("Tinted", s.x1, s.y - 16);
  const kx = lerp(s.x0 + 19, s.x1 - 19, v);
  pill(ctx, { x: s.x0, y: s.y - 3, w: s.x1 - s.x0, h: 6 }, color("fillPressed"));
  pill(ctx, { x: s.x0, y: s.y - 3, w: kx - s.x0, h: 6 }, color("blue"));
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath(); ctx.roundRect(kx - 19, s.y - 12, 38, 24, 12); ctx.fill();
  ctx.restore();

  // Toggle chips: solid system blue when on (a fill, not glass).
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `500 ${small ? 13 : 14}px ${FONT}`;
  const pressed = [mouse, ...cursors].find((p) => p.ui?.kind === "chip")?.ui.chip.key;
  for (const c of ui.chips) {
    const onState = Boolean(S[c.key]);
    pill(ctx, c, onState ? color("blue") : c.key === pressed ? color("fillPressed") : color("fill"));
    if (onState && c.key === pressed) pill(ctx, c, "rgba(0,0,0,0.15)");
    ctx.fillStyle = onState ? "#FFFFFF" : label;
    ctx.fillText(c.label, c.x + c.w / 2, c.y + c.h / 2 + 0.5);
  }
}

function drawToast(ctx, label) {
  const id = E.toast;
  const shown = id !== undefined ? clamp((simTime - toastAt - 0.1) / 0.2) : 1 - clamp((simTime - toastGoneAt) / 0.15);
  const f = (id !== undefined && frameOf(id)) || (shown > 0 && L.toast);
  if (!f || shown <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = shown;
  const c = center(f);
  ctx.font = `500 ${L.portrait ? 14 : 15}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const text = toastText;
  const w = ctx.measureText(text).width + 26;
  const x = c.x - w / 2;
  ctx.strokeStyle = toastOk ? color("green") : "#FF9F0A";
  ctx.lineWidth = 2.2;
  if (toastOk) stroke(ctx, [[x, c.y], [x + 5, c.y + 5], [x + 14, c.y - 6]]);
  else { stroke(ctx, [[x + 7, c.y - 7], [x + 7, c.y + 2]]); stroke(ctx, [[x + 7, c.y + 7], [x + 7, c.y + 7.5]]); }
  ctx.fillStyle = label;
  ctx.fillText(text, x + 26, c.y + 1);
  ctx.restore();
}

function drawCursors(ctx) {
  for (const c of cursors) {
    if (c.alpha <= 0.01) continue;
    const { x, y } = c.pos;
    ctx.save();
    ctx.globalAlpha = c.alpha;
    // Touch indicator while pressed.
    if (c.pressT > 0.01) {
      ctx.fillStyle = `rgba(${rgb(c.tint).join(",")},${0.16 * c.pressT})`;
      ctx.strokeStyle = `rgba(${rgb(c.tint).join(",")},${0.5 * c.pressT})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 14 + 8 * c.pressT, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    const s = 1 - 0.1 * c.pressT;
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.shadowColor = "rgba(0,0,0,0.22)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, 21); ctx.lineTo(5.2, 16.2); ctx.lineTo(9.4, 25.2);
    ctx.lineTo(13, 23.6); ctx.lineTo(8.9, 14.8); ctx.lineTo(15.6, 14.8); ctx.closePath();
    ctx.fillStyle = c.tint;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.font = `600 13px ${FONT}`;
    const tw = ctx.measureText(c.name).width;
    ctx.fillStyle = c.tint;
    ctx.beginPath(); ctx.roundRect(14, 25, tw + 18, 24, 12); ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(c.name, 23, 37.5);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- frame loop

let lastLight = 0, animating = true;

function advance(dt) {
  const smooth = (v, target, rate) => v + (target - v) * (1 - Math.exp(-dt * rate));
  S.darkT = S.reduceMotion ? (S.dark ? 1 : 0) : smooth(S.darkT, S.dark ? 1 : 0, 9);
  if (Math.abs(S.darkT - (S.dark ? 1 : 0)) < 0.002) S.darkT = S.dark ? 1 : 0;
  for (const c of cursors) {
    c.update(simTime);
    c.alpha = smooth(c.alpha, S.autoplay ? 1 : 0, 8);
    c.pressT = smooth(c.pressT, c.down ? 1 : 0, 22);
  }
  // Light: the toolbar sweeps it; the cursors tilt it a little, like a phone in a hand.
  const xs = S.autoplay ? cursors.map((c) => c.pos.x) : mouse.pos ? [mouse.pos.x] : [W / 2];
  const tilt = ((xs.reduce((a, b) => a + b, 0) / xs.length - W / 2) / (W / 2)) * 18;
  const light = S.lightSweep + tilt;
  if (Math.abs(light - lastLight) > 0.2) { gl.setLightAngle(light); lastLight = light; }

  drawBack();
  gl.setContent(back);
  animating = gl.frame(dt);
  drawInk();
}

const settling = () => Math.abs(S.darkT - (S.dark ? 1 : 0)) > 0 || cursors.some((c) => Math.abs(c.alpha - (S.autoplay ? 1 : 0)) > 0.01 || c.pressT > 0.01);

let running = false, last = 0;
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  simTime += dt;
  runTimers();
  advance(dt);
  running = S.autoplay || animating || settling() || timers.length > 0 || mouse.down;
  if (running) requestAnimationFrame(tick);
}
function wake() {
  if (running || RECORD) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- boot

async function boot() {
  if (!navigator.gpu) return showFallback();
  await Promise.all([
    document.fonts.load(`400 100px ${SERIF}`),
    document.fonts.load(`400 16px ${FONT}`),
    document.fonts.load(`500 16px ${FONT}`),
    document.fonts.load(`600 16px ${FONT}`),
    document.fonts.load(`400 12px ${MONO}`),
  ]).catch(() => {});
  await init();
  measureViewport();
  try {
    gl = await Showcase.create(glassCanvas, dpr * fit);
  } catch (err) {
    console.error(err);
    return showFallback();
  }
  buildScene();
  if (RECORD) document.documentElement.classList.add("recording");
  addEventListener("resize", () => {
    if (RECORD) return;
    measureViewport();
    gl.resize(glassCanvas.width, glassCanvas.height, dpr * fit);
    relayout();
    wake();
  });
  if (RECORD) {
    // Deterministic stepping for the recorder: advance the clock, let scripted
    // continuations run, draw one frame.
    window.__step = async (dt) => {
      simTime += dt;
      runTimers();
      await new Promise((r) => setTimeout(r, 0));
      advance(dt);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    };
    startAutoplay();
    cursors.forEach((c) => (c.alpha = 1));
    // Settle the opening state (materialize finished) without spending video time.
    for (let i = 0; i < 40; i++) { gl.frame(1 / 60); }
    window.__ready = true;
  } else if (params.has("still")) {
    S.autoplay = false;
    wake();
  } else {
    startAutoplay();
  }
}

function relayout() {
  setFrame(E.slab, L.slab);
  setFrame(E.panel, L.panel);
  setFrame(E.knob, S.merge ? L.knobOn : L.knobOff);
  setFrame(E.pairA, L.pairA);
  setFrame(E.pairB, L.pairB);
  setFrame(E.refKnob, knobRect(L.refKnob, refCenter()));
  setFrame(E.hueKnob, knobRect(L.hueKnob, hueCenter()));
  E.tools.forEach((id, i) => setFrame(id, L.toolbar[i]));
  setFrame(E.cta, L.cta);
  setFrame(E.plus, L.plus);
  if (S.lensShown) setFrame(E.lens, L.lensHome);
  toggleMenu(false);
  cursors.forEach((c, i) => (c.park = L.park[i]));
  if (S.autoplay) startAutoplay();
}

function showFallback() {
  document.getElementById("stage").hidden = true;
  document.getElementById("fallback").hidden = false;
}

boot();
