// Board juice for Latent Legends: pooled particles from the particle textures, screen shake, hit-stop
// and the ambient life of the arena. Everything is in board space (1536x864) and runs on game time, so it
// follows the speed setting and freezes with hit-stop. The p_* textures are RGB on black: drawn with 'lighter'.

const TEX = ['ember', 'star', 'glow', 'snow', 'shard', 'flame', 'ring', 'slash', 'dust', 'rune', 'flare', 'impact'];
const tex = {};
const CAP = 600;
const pool = [], live = [];

// arena landmarks on the board image
const TORCHES = [[56, 96], [1462, 140], [141, 738]];
const SHRINE_GEM = { 0: [[358, 678], [767, 677], [1179, 678]], 1: [[467, 36], [768, 42], [1075, 37]] };
const LEY = { x0: 262, x1: 1274, y: 384, nodes: [410, 768, 1129] };

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];

// a black-backed copy of a texture multiplied by a colour (stays additive)
function tint(src, rgb) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const b = c.getContext('2d');
  b.drawImage(src, 0, 0);
  b.globalCompositeOperation = 'multiply';
  b.fillStyle = rgb; b.fillRect(0, 0, c.width, c.height);
  return c;
}
function radial(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const b = c.getContext('2d');
  const r = b.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) r.addColorStop(o, col);
  b.fillStyle = r; b.fillRect(0, 0, size, size);
  return c;
}

export async function loadFx(loadImage) {
  await Promise.all(TEX.map(async (n) => {
    const im = await loadImage(`assets/ui/p_${n}.webp`);
    if (im) tex[n] = await createImageBitmap(im).catch(() => im);
  }));
  if (tex.glow) {
    tex.glowMint = tint(tex.glow, '#7dffb0'); tex.glowRed = tint(tex.glow, '#ff7a3c');
    tex.glowBlue = tint(tex.glow, '#6fc3ff'); tex.glowGold = tint(tex.glow, '#ffc861');
    tex.glowViolet = tint(tex.glow, '#c79bff'); tex.glowGreen = tint(tex.glow, '#7fd66b'); tex.glowYellow = tint(tex.glow, '#f2e04e');
  }
  if (tex.star) tex.starMint = tint(tex.star, '#9dffc8');
  // drawn with normal blending
  tex.smoke = radial(128, [[0, 'rgba(30,26,24,0.55)'], [0.6, 'rgba(30,26,24,0.25)'], [1, 'rgba(30,26,24,0)']]);
  tex.puff = radial(128, [[0, 'rgba(235,220,190,0.45)'], [0.6, 'rgba(235,220,190,0.18)'], [1, 'rgba(235,220,190,0)']]);
  tex.light = radial(128, [[0, 'rgba(255,190,110,0.55)'], [0.35, 'rgba(255,150,60,0.22)'], [1, 'rgba(255,120,40,0)']]);
  tex.lightBlue = radial(128, [[0, 'rgba(140,210,255,0.5)'], [0.35, 'rgba(90,170,255,0.2)'], [1, 'rgba(60,140,255,0)']]);
  tex.lightRed = radial(128, [[0, 'rgba(255,140,80,0.5)'], [0.35, 'rgba(255,100,40,0.2)'], [1, 'rgba(255,80,30,0)']]);
}

// ---------- particles ----------
// p: { tex, x, y, vx, vy, grav, drag, t, life, s0, s1, a, fade, rot, vr, flat, stretch, add, layer, sway, swayF, real }
// real: an ambient particle that runs on wall time, so it keeps its calm pace at x4 and through hit-stop
export function emit(o) {
  if (!tex[o.tex]) return;
  const p = live.length >= CAP ? live.shift() : pool.pop() ?? {};
  Object.assign(p, {
    vx: 0, vy: 0, grav: 0, drag: 0, t: 0, life: 600, s0: 20, s1: 20, a: 1, fade: 0.15, rot: 0, vr: 0,
    flat: 1, stretch: 0, add: true, layer: 'top', sway: 0, swayF: 0, delay: 0, real: false,
  }, o);
  live.push(p);
}

// dt: game ms (0 during hit-stop), rdt: wall ms
export function stepFx(gdt, rdt = gdt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const p = live[i], dt = p.real ? rdt : gdt, s = dt / 1000;
    if (!dt) continue;
    if (p.delay > 0) { p.delay -= dt; continue; }
    p.t += dt;
    if (p.t >= p.life) { pool.push(live[i]); live[i] = live[live.length - 1]; live.pop(); continue; }
    if (p.drag) { const k = Math.exp(-p.drag * s); p.vx *= k; p.vy *= k; }
    p.vy += p.grav * s;
    p.x += p.vx * s; p.y += p.vy * s;
    p.rot += p.vr * s;
  }
  stepAmbient(Math.min(rdt, 250));
}

// base: the board transform for this frame (a uniform scale and a translation)
export function drawFx(g, layer) {
  const m = g.getTransform(), a = m.a, e = m.e, f = m.f;
  let mode = '';
  for (const p of live) {
    if (p.layer !== layer || p.delay > 0) continue;
    const u = p.t / p.life;
    const al = p.a * (u < p.fade ? u / p.fade : 1 - Math.pow((u - p.fade) / (1 - p.fade), 2));
    if (al <= 0.01) continue;
    const want = p.add ? 'lighter' : 'source-over';
    if (want !== mode) { g.globalCompositeOperation = want; mode = want; }
    g.globalAlpha = Math.min(1, al);
    const sz = p.s0 + (p.s1 - p.s0) * u;
    let x = p.x;
    if (p.sway) x += Math.sin((p.t / 1000) * p.swayF + p.sway) * 6;
    const im = tex[p.tex];
    let sx = sz, sy = sz * p.flat, rot = p.rot;
    if (p.stretch) {
      // sparks stretch along their velocity
      const sp = Math.hypot(p.vx, p.vy);
      sx = sz * (1 + Math.min(3, (sp / 600) * p.stretch)); sy = sz * 0.5;
      rot = Math.atan2(p.vy, p.vx);
    }
    if (rot) {
      const c = Math.cos(rot) * a, sn = Math.sin(rot) * a;
      g.setTransform(c, sn, -sn, c, e + a * x, f + a * p.y);
      g.drawImage(im, -sx / 2, -sy / 2, sx, sy);
    } else {
      g.setTransform(a, 0, 0, a, e, f);
      g.drawImage(im, x - sx / 2, p.y - sy / 2, sx, sy);
    }
  }
  g.setTransform(m);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function clearFx() { while (live.length) pool.push(live.pop()); }

// ---------- emitters ----------
// each element's particles: its glow, its spark, the bits a cast throws and how they drift (fire rises, frost falls)
const EL = {
  Fire: { glow: 'glowRed', spark: 'ember', bits: ['ember', 'flame', 'star'], grav: -60 },
  Frost: { glow: 'glowBlue', spark: 'shard', bits: ['snow', 'shard', 'star'], grav: 120 },
  Wild: { glow: 'glowGreen', spark: 'dust', bits: ['dust', 'star', 'flare'], grav: 60 },
  Storm: { glow: 'glowYellow', spark: 'flare', bits: ['flare', 'shard', 'star'], grav: 0 },
  Shadow: { glow: 'glowViolet', spark: 'rune', bits: ['rune', 'dust', 'star'], grav: -30 },
};
const GOLD = { glow: 'glowGold', spark: 'star', bits: ['star', 'dust'], grav: 120 };
const pal = (e) => EL[e] ?? GOLD;

export function summonBurst(x, y, sr, element) {
  emit({ tex: 'ring', x, y, life: 520, s0: 30 * sr, s1: 230 * sr, flat: 0.36, a: 0.9, fade: 0.05, layer: 'ground' });
  emit({ tex: 'ring', x, y, life: 700, s0: 10 * sr, s1: 160 * sr, flat: 0.36, a: 0.6, fade: 0.1, layer: 'ground', delay: 80 });
  emit({ tex: pal(element).glow, x, y: y - 30 * sr, life: 450, s0: 120 * sr, s1: 220 * sr, a: 0.8, fade: 0.05 });
  for (let i = 0; i < 14; i++) {
    const ang = rnd(0, Math.PI * 2), sp = rnd(160, 340) * sr;
    emit({ tex: 'star', x, y: y - 6, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.38 - rnd(80, 200), grav: 420, drag: 2.2,
      life: rnd(380, 620), s0: rnd(10, 18) * sr, s1: 2, a: 1, stretch: 0.8 });
  }
  const p = pal(element);
  for (let i = 0; i < 10; i++) {
    emit({ tex: pick(p.bits.slice(0, 2)), x: x + rnd(-50, 50) * sr, y: y - rnd(0, 30) * sr,
      vx: rnd(-40, 40), vy: -rnd(60, 180), grav: p.grav < 0 ? -40 : 30, drag: 1, life: rnd(700, 1200),
      s0: rnd(14, 28) * sr, s1: rnd(4, 10) * sr, a: 0.9, rot: rnd(0, 6), vr: rnd(-3, 3), sway: rnd(0, 6), swayF: rnd(3, 6) });
  }
  dustRing(x, y, sr, 8);
}

export function dustRing(x, y, sr, n = 6) {
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3), sp = rnd(70, 130) * sr;
    emit({ tex: 'puff', add: false, x: x + Math.cos(ang) * 20 * sr, y: y + Math.sin(ang) * 8 * sr, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.35 - 10,
      drag: 3, life: rnd(500, 800), s0: 34 * sr, s1: 70 * sr, a: 0.55, fade: 0.1, layer: 'ground' });
  }
}

// dir: unit vector from attacker to target; power ~ damage
export function hitImpact(x, y, dx, dy, power, kind, element) {
  const pw = Math.min(1.6, 0.6 + power * 0.12);
  const magic = kind === 'magic', pure = kind === 'pure';
  emit({ tex: 'impact', x, y, life: 240, s0: 70 * pw, s1: 150 * pw, a: 1, fade: 0.05, rot: rnd(0, 6) });
  emit({ tex: magic ? 'glowGold' : pure ? 'glowViolet' : 'glow', x, y, life: 300, s0: 140 * pw, s1: 60 * pw, a: 0.8, fade: 0.02 });
  if (magic || pure) emit({ tex: 'rune', x, y, life: 420, s0: 50 * pw, s1: 150 * pw, a: 0.7, fade: 0.05, vr: 3 });
  else emit({ tex: 'slash', x, y, life: 260, s0: 120 * pw, s1: 150 * pw, a: 0.95, fade: 0.05, rot: Math.atan2(dy, dx) + rnd(-0.6, 0.6) });
  const spark = pal(element).spark;
  for (let i = 0; i < 12; i++) {
    const ang = Math.atan2(dy, dx) + rnd(-1.0, 1.0), sp = rnd(260, 620) * pw;
    emit({ tex: i % 3 ? 'star' : spark, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - rnd(40, 160), grav: 700, drag: 2.5,
      life: rnd(260, 520), s0: rnd(10, 20), s1: 2, stretch: 1 });
  }
}

export function deathBurst(x, y, sr, element) {
  for (let i = 0; i < 9; i++)
    emit({ tex: i % 3 ? 'glow' : pal(element).glow, x: x + rnd(-30, 30) * sr, y: y - rnd(20, 110) * sr,
      vx: rnd(-20, 20), vy: -rnd(50, 110), drag: 0.6, life: rnd(1100, 1700), s0: rnd(20, 34) * sr, s1: 4, a: 0.75,
      sway: rnd(0, 6), swayF: rnd(2, 4), delay: i * 60 });
  for (let i = 0; i < 6; i++)
    emit({ tex: 'smoke', add: false, x: x + rnd(-40, 40) * sr, y: y - rnd(0, 60) * sr, vx: rnd(-30, 30), vy: -rnd(20, 60), drag: 1,
      life: rnd(900, 1400), s0: 50 * sr, s1: 110 * sr, a: 0.6, fade: 0.15 });
  dustRing(x, y, sr, 6);
}

export function shrineHit(x, y, side, dmg) {
  const blue = side === 0;
  emit({ tex: blue ? 'glowBlue' : 'glowRed', x, y, life: 420, s0: 160, s1: 260, a: 0.9, fade: 0.04 });
  emit({ tex: 'impact', x, y, life: 260, s0: 90, s1: 170, a: 1, fade: 0.05, rot: rnd(0, 6) });
  for (let i = 0; i < 10 + dmg * 2; i++) {
    const ang = rnd(-Math.PI, 0), sp = rnd(220, 520);
    emit({ tex: blue ? pick(['shard', 'snow', 'star']) : pick(['ember', 'flame', 'star']), x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      grav: 900, drag: 1.5, life: rnd(500, 900), s0: rnd(14, 26), s1: 4, rot: rnd(0, 6), vr: rnd(-8, 8) });
  }
}

export function shrineFall(x, y, side) {
  emit({ tex: 'flare', x, y, life: 600, s0: 200, s1: 520, a: 1, fade: 0.03 });
  emit({ tex: 'ring', x, y: y + 30, life: 700, s0: 40, s1: 420, flat: 0.4, a: 0.9, fade: 0.04, layer: 'ground' });
  shrineHit(x, y, side, 8);
  for (let i = 0; i < 12; i++)
    emit({ tex: 'smoke', add: false, x: x + rnd(-60, 60), y: y + rnd(-30, 30), vx: rnd(-40, 40), vy: -rnd(30, 90), drag: 0.8,
      life: rnd(1800, 3000), s0: 70, s1: 160, a: 0.7, fade: 0.08, delay: i * 70 });
}

export function healBurst(x, y, sr) {
  emit({ tex: 'glowMint', x, y, life: 600, s0: 80 * sr, s1: 160 * sr, a: 0.7, fade: 0.1 });
  for (let i = 0; i < 12; i++)
    emit({ tex: 'starMint', x: x + rnd(-40, 40) * sr, y: y + rnd(-30, 40) * sr, vx: rnd(-20, 20), vy: -rnd(60, 140), drag: 1,
      life: rnd(700, 1100), s0: rnd(12, 22) * sr, s1: 3, delay: i * 30 });
}

export function castBurst(x, y, element, big = false) {
  const k = big ? 1.4 : 1;
  const p = pal(element);
  emit({ tex: p.glow, x, y, life: 500, s0: 100 * k, s1: 260 * k, a: 0.85, fade: 0.05 });
  for (let i = 0; i < 18; i++) {
    const ang = rnd(0, Math.PI * 2), sp = rnd(120, 320) * k;
    emit({ tex: pick(p.bits),
      x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.6 - 60, grav: p.grav, drag: 1.8,
      life: rnd(600, 1000), s0: rnd(14, 26) * k, s1: 4, rot: rnd(0, 6), vr: rnd(-4, 4) });
  }
}

export function auraPulse(x, y, sr, element) {
  emit({ tex: pal(element).glow, x, y: y - 50 * sr, life: 500, s0: 80 * sr, s1: 180 * sr, a: 0.6, fade: 0.1 });
  emit({ tex: 'ring', x, y, life: 600, s0: 40 * sr, s1: 170 * sr, flat: 0.36, a: 0.8, fade: 0.05, layer: 'ground' });
}

// ---------- screen shake and hit-stop (real time, so they feel the same at every game speed) ----------
let trauma = 0, shakeT = 0;
export function shake(amount) { trauma = Math.min(1, trauma + amount); }
export function shakeOffset(dtReal, out) {
  trauma = Math.max(0, trauma - dtReal / 1000 * 1.7);
  shakeT += dtReal / 1000;
  const amp = 26 * trauma * trauma;
  out.x = amp * (Math.sin(shakeT * 47.3) * 0.6 + Math.sin(shakeT * 91.7 + 1.3) * 0.4);
  out.y = amp * (Math.sin(shakeT * 53.1 + 2.1) * 0.6 + Math.sin(shakeT * 83.9 + 0.4) * 0.4);
}
let stopUntil = 0;
export function hitstop(ms) { stopUntil = Math.max(stopUntil, performance.now() + ms); }
export const stopped = (now) => now < stopUntil;

// ---------- ambient life ----------
let amb = 0, emberAcc = 0, moteAcc = 0, torchAcc = 0, smokeAcc = 0;
let shrineAlive = [[true, true, true], [true, true, true]];
export function setShrines(down) { shrineAlive = down.map((r) => r.map((d) => !d)); }

function stepAmbient(dt) {
  amb += dt;
  emberAcc += dt; moteAcc += dt; torchAcc += dt; smokeAcc += dt;
  // embers rise from the enemy shrines, frost motes from yours
  while (emberAcc > 260) {
    emberAcc -= 260;
    const lane = (Math.random() * 3) | 0;
    if (shrineAlive[1][lane]) {
      const [x, y] = SHRINE_GEM[1][lane];
      emit({ tex: 'ember', x: x + rnd(-14, 14), y: y + rnd(-6, 10), vx: rnd(-10, 10), vy: -rnd(25, 55), drag: 0.3, life: rnd(1400, 2200),
        s0: rnd(7, 12), s1: 2, a: 0.8, sway: rnd(0, 6), swayF: rnd(2, 4), layer: 'ground', real: true });
    }
    const l2 = (Math.random() * 3) | 0;
    if (shrineAlive[0][l2]) {
      const [x, y] = SHRINE_GEM[0][l2];
      emit({ tex: pick(['snow', 'glowBlue']), x: x + rnd(-18, 18), y: y + rnd(-10, 14), vx: rnd(-8, 8), vy: -rnd(18, 40), drag: 0.3,
        life: rnd(1600, 2600), s0: rnd(8, 13), s1: 2, a: 0.75, rot: rnd(0, 6), vr: rnd(-1, 1), sway: rnd(0, 6), swayF: rnd(1.5, 3), layer: 'ground', real: true });
    }
  }
  // dust motes drifting over the arena
  while (moteAcc > 380) {
    moteAcc -= 380;
    emit({ tex: 'glowGold', x: rnd(250, 1290), y: rnd(90, 760), vx: rnd(-8, 8), vy: -rnd(4, 14), life: rnd(3000, 5000),
      s0: rnd(5, 9), s1: rnd(3, 6), a: rnd(0.25, 0.5), fade: 0.3, sway: rnd(0, 6), swayF: rnd(0.6, 1.4), layer: 'ground', real: true });
  }
  // sparks off the torches
  while (torchAcc > 320) {
    torchAcc -= 320;
    const [x, y] = pick(TORCHES);
    emit({ tex: 'ember', x: x + rnd(-10, 10), y: y - 10, vx: rnd(-14, 14), vy: -rnd(40, 90), drag: 0.4, life: rnd(700, 1200),
      s0: rnd(6, 10), s1: 2, a: 0.9, sway: rnd(0, 6), swayF: rnd(3, 5), layer: 'ground', real: true });
  }
  // a fallen shrine keeps smoking
  while (smokeAcc > 450) {
    smokeAcc -= 450;
    for (const side of [0, 1])
      SHRINE_GEM[side].forEach(([x, y], lane) => {
        if (shrineAlive[side][lane]) return;
        emit({ tex: 'smoke', add: false, x: x + rnd(-16, 16), y: y + rnd(4, 14), vx: rnd(-6, 6), vy: -rnd(16, 30), drag: 0.15,
          life: rnd(2400, 3400), s0: rnd(24, 34), s1: rnd(70, 95), a: 0.38, fade: 0.25, sway: rnd(0, 8), swayF: rnd(0.4, 0.9), layer: 'ground', real: true });
      });
  }
}

// flickering torch light, shrine glows and the pulse along the ley line; ground layer, before the units
export function drawAmbient(g) {
  const t = amb / 1000;
  g.globalCompositeOperation = 'lighter';
  TORCHES.forEach(([x, y], i) => {
    const fl = 0.75 + 0.15 * Math.sin(t * 9.1 + i * 2) + 0.1 * Math.sin(t * 23.7 + i);
    const r = 150 * fl;
    g.globalAlpha = 0.55 * fl;
    g.drawImage(tex.light, x - r, y - r, r * 2, r * 2);
  });
  for (const side of [0, 1])
    SHRINE_GEM[side].forEach(([x, y], lane) => {
      if (!shrineAlive[side][lane]) return;
      const p = 0.8 + 0.2 * Math.sin(t * 2.2 + lane * 1.7 + side);
      const r = 95 * p;
      g.globalAlpha = 0.6 * p;
      g.drawImage(side ? tex.lightRed : tex.lightBlue, x - r, y - r * 0.8, r * 2, r * 1.6);
    });
  // a slow pulse of light travels along the ley line, brightening each node it passes
  if (tex.flare) {
    const period = 4.8, u = (t % period) / period;
    const px = LEY.x0 + (LEY.x1 - LEY.x0) * u;
    g.globalAlpha = 0.38 * Math.sin(Math.PI * u);
    g.drawImage(tex.flare, px - 110, LEY.y - 26, 220, 52);
    for (const nx of LEY.nodes) {
      const d = Math.abs(nx - px), k = Math.max(0, 1 - d / 120);
      const base = 0.14 + 0.06 * Math.sin(t * 2 + nx);
      g.globalAlpha = base + 0.45 * k;
      g.drawImage(tex.glowGold, nx - 46, LEY.y - 46, 92, 92);
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

export const fxTex = tex;
