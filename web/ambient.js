// Ambient decor: short video loops of the braziers, the torch and the banners, drawn over board_clean.webp.
// Each clip is an opaque H.264 mp4 whose pixels equal the board outside the moving thing, plus a feathered alpha
// mask (PNG) applied with 'destination-in' on a small canvas, so it sits on the board without a seam.
// Rects in assets/ambient.json are in board space (1536x864).
//
//   import { loadAmbient, drawAmbient, setAmbientPaused } from './ambient.js';
//   await loadAmbient();          // never rejects; resolves with the names of the clips that are ready
//   drawAmbient(g);               // right after the board image, with the board transform already set
//   setAmbientPaused(true|false); // e.g. when the tab hides or a menu covers the board
//
// Why not WebM with alpha: Chrome decodes VP9 alpha in software and drawImage of such a video cost 0.3 to 0.5 ms per
// clip on the main thread; a hardware-decoded H.264 clip costs about 0.03 ms, and the mask is one more GPU draw.

const BASE = new URL('./', import.meta.url);
let clips = [];
let paused = false;
let unlockArmed = false;

export async function loadAmbient(manifest = 'assets/ambient.json') {
  let list;
  try {
    const r = await fetch(new URL(manifest, BASE));
    if (!r.ok) return [];
    list = await r.json();
  } catch { return []; }
  if (!Array.isArray(list)) return [];
  const ready = await Promise.all(list.map(loadClip));
  for (const c of clips) { c.v.pause(); c.v.removeAttribute('src'); c.v.load(); }   // a second load replaces the first
  clips = ready.filter(Boolean);
  if (!paused && !document.hidden) playAll();
  return clips.map((c) => c.name);
}

// a hidden tab does not decode the loops; they resume where they were
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const c of clips) c.v.pause();
  else if (!paused) playAll();
});

// the clip is fetched whole into a blob URL (each is under 260 KB): a blob is always seekable, so looping and the
// stagger seek work on any static server, with or without range requests
async function loadClip(c, i) {
  let url, mask;
  try {
    const [r, m] = await Promise.all([fetch(new URL(c.file, BASE)), loadImage(new URL(c.mask, BASE).href)]);
    if (!r.ok || !m) return null;
    url = URL.createObjectURL(await r.blob());
    mask = m;
  } catch { return null; }
  const v = document.createElement('video');
  v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
  const ok = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    v.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
    v.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(true); }, { once: true });
    v.src = url;
  });
  if (!ok) { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); return null; }
  // stagger the loops so the clips do not restart together
  if (v.duration > 1 && i) {
    v.currentTime = (i * 1.37) % v.duration;
    await new Promise((r) => { const t = setTimeout(r, 2000); v.addEventListener('seeked', () => { clearTimeout(t); r(); }, { once: true }); });
  }
  const oc = document.createElement('canvas');
  oc.width = c.vw || v.videoWidth; oc.height = c.vh || v.videoHeight;
  return { ...c, v, mask, oc, og: oc.getContext('2d'), shown: -1 };
}

function loadImage(src) {
  return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
}

function playAll() {
  for (const c of clips) {
    const p = c.v.play();
    if (p && p.catch) p.catch(armUnlock);
  }
}

// autoplay blocked: start on the first pointerdown anywhere
function armUnlock() {
  if (unlockArmed) return;
  unlockArmed = true;
  window.addEventListener('pointerdown', () => { unlockArmed = false; if (!paused) playAll(); }, { once: true, capture: true });
}

export function drawAmbient(g) {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i], v = c.v;
    if (v.readyState < 2) { if (c.shown >= 0) g.drawImage(c.oc, c.x, c.y, c.w, c.h); continue; }
    // re-mask only when the video shows a new frame (24 fps), not on every 60 Hz draw
    const f = Math.floor(v.currentTime * c.fps);
    if (f !== c.shown) {
      const og = c.og;
      og.globalCompositeOperation = 'copy';
      og.drawImage(v, 0, 0, c.oc.width, c.oc.height);
      og.globalCompositeOperation = 'destination-in';
      og.drawImage(c.mask, 0, 0, c.oc.width, c.oc.height);
      c.shown = f;
    }
    g.drawImage(c.oc, c.x, c.y, c.w, c.h);
  }
}

export function setAmbientPaused(p) {
  paused = !!p;
  if (paused) for (const c of clips) c.v.pause();
  else if (!document.hidden) playAll();
}

