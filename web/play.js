// Latent Legends: you (bottom, seen from behind) against the greedy bot (top, seen from the front).
// The real engine runs the match; every engine event drives a sprite, its own sound, or a VFX sheet.
// Assets are data driven: sprites.json, vfx.json and portraits/ may be partial; anything missing gets a fallback.
import { indexCards, newGame, apply, reveal, legalActions, currentActor, findUnit, slotFor } from '../engine/rules.js';
import { BOTS, BOT_LEVELS } from '../sim/bots/greedy.js';
import { POOL, STARTERS } from '../engine/deck.js';
import * as FX from './fx.js';
import { uiArt } from './uiart.js';
import { createUI, numImg } from './ui.js';
import { createMenu } from './menu.js';
import { createGuide, handRect } from './guide.js';
import { onlineHere } from './net.js';
// video loops of the board's own braziers, torch and banners; fx.js has its own drawAmbient (the torch glow)
import { loadAmbient, drawAmbient as drawDecor, setAmbientPaused } from './ambient.js';

// the default deck when nothing else is chosen; menu.js lets the player build their own (engine/deck.js rules)
const DECK = STARTERS.balanced.cards;
const KEY = { cinder_raider: 'cinder', glacier_shield: 'glacier', crystal_wall_token: 'crystal_wall' };
const keyOf = (id) => KEY[id] ?? id;

// Board space: every board coordinate below (RING, SHRINE, units, effects) is in the 1536x864 board image.
// The board is drawn into a fixed 1920x1080 stage through CAM, leaving room for the enemy panel on top and the hand below;
// the stage itself is scaled to the window by CSS, and the canvas backing store follows the real pixel size.
const W = 1536, H = 864;
const STAGE_W = 1920, STAGE_H = 1080;
const CAM = { s: 1.12, ox: (1920 - 1536 * 1.12) / 2, oy: 56 };
const cam = { x: 0, y: 0 };          // camera offset in stage px on top of CAM (screen shake, small drifts)
// ring centres on the board image: RING[side][slot][lane] = [x, y, ring width]
const RING = {
  0: [[[417, 467, 111], [768, 468, 111], [1118, 468, 111]], [[400, 597, 117], [768, 597, 117], [1134, 597, 117]]],
  1: [[[447, 295, 109], [768, 295, 109], [1089, 295, 109]], [[460, 193, 104], [768, 193, 104], [1076, 193, 104]]],
};
const SHRINE = { 0: [[355, 690], [768, 690], [1180, 690]], 1: [[460, 52], [768, 48], [1072, 52]] };
const CHAR_H = 150, SPRITE_H = 187.5;
const DROP_MS = 240;                                     // a summoned unit falls onto its ring for this long
const RANGED = new Set(['Archer', 'Mage', 'Support']);   // these shoot a bolt instead of stepping in
const CONSEQ = new Set(['Damage', 'Death', 'ShrineHit', 'ShrineDown', 'Status', 'Heal', 'LaneClosed', 'Relocate', 'Recall']);
// a fallen Shrine closes its lane: these follow ShrineDown inside the same attack or spell, and play a beat later
const LANE_EV = new Set(['LaneClosed', 'Relocate', 'Recall']);
const ECOL = { Fire: '#ff7a4d', Frost: '#6fc3ff', Wild: '#7fd66b', Storm: '#f2d94e', Shadow: '#b48cff' };
const ecol = (e) => ECOL[e] ?? '#c9b79c';
const SKILL_NAME = { taunt: 'Taunt', dive: 'Dive', blast: 'Blast', snipe: 'Snipe', siphon: 'Siphon' };
const params = new URLSearchParams(location.search);
const AUTOPLAY = params.get('autoplay') === '1';
// online rooms (web/net.js to cloudflare/worker.js, or server/rooms.mjs locally); ?online=0 hides them, and so does a
// built page with no room server address in it
const ONLINE = params.get('online') !== '0' && onlineHere();
// the player's settings, kept between visits (the MENU panel, and SETTINGS from the title): sound, screen shake, speed, auto combat
const settings = (() => { try { return JSON.parse(localStorage.getItem('latent.settings')) ?? {}; } catch { return {}; } })();
const saveSettings = () => { if (!AUTOPLAY) try { localStorage.setItem('latent.settings', JSON.stringify(settings)); } catch {} };
let shakeOn = settings.shake ?? !matchMedia('(prefers-reduced-motion: reduce)').matches;
function shake(amount) { if (shakeOn) FX.shake(amount); }

const $ = (id) => document.getElementById(id);
const canvas = $('board'), g = canvas.getContext('2d');

// ---------- assets (all optional except the board and the card data) ----------
// every file the game waits on moves the loading bar (boot.js); later loads pass straight through
const track = (p) => window.__boot?.track(p) ?? p;
const loadImage = (src) => track(new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; }));
const getJson = (url) => track(fetch(url).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
// optional folders are discovered from the dev server's directory listing, so files that do not exist yet are never requested;
// a static host has no listings, so the site build (tools/build_site.sh) writes them to assets/listing.json instead
const listing = await track(fetch('assets/listing.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));
async function listDir(path) {
  if (listing) return new Set(listing[path] ?? []);
  try {
    const r = await fetch(path);
    if (!r.ok) return new Set();
    return new Set([...(await r.text()).matchAll(/href="([^"?/]+)\/?"/g)].map((m) => decodeURIComponent(m[1])));
  } catch { return new Set(); }
}
const assetFiles = await listDir('assets/');
const [meta, vfxMeta, cardData, boardImg, portraitFiles, vfxFiles] = await Promise.all([
  getJson('assets/sprites.json'), assetFiles.has('vfx.json') ? getJson('assets/vfx.json') : {}, getJson('../data/cards.json'),
  // board_clean is the board without its slot rings: the rings are drawn as sprites (drawRings)
  loadImage('assets/board_clean.webp'),
  assetFiles.has('portraits') ? listDir('assets/portraits/') : new Set(), assetFiles.has('vfx') ? listDir('assets/vfx/') : new Set(),
]);
const db = indexCards(cardData.cards);
const decorOn = !!boardImg;
if (decorOn) loadAmbient();   // not awaited: the title must not wait on video; the loops appear once they are ready
setAmbientPaused(true);   // the menus cover the board until a match starts
const sheets = {}, vfxSheets = {}, portraits = {};
// Sheets are held as decoded ImageBitmaps: as plain Images the browser evicts and re-decodes them mid-match (33 to 150 ms hitches).
// ?bitmap=0 turns this off for comparison.
const BITMAP = params.get('bitmap') !== '0';
// Phones and tablets get the half-size sheets, and only the ones this match can put on the board:
// the full sheets decode to gigabytes, past what mobile Safari lets a tab hold, and it reloads the page.
// ?lite=1 or ?lite=0 forces either way.
const LITE = params.has('lite') ? params.get('lite') !== '0' : matchMedia('(pointer: coarse)').matches;
const sheetLoads = new Map();   // name -> the promise of its load
const sheetDrops = new Set();   // loads still on their way that are no longer wanted
function loadSheet(n) {
  sheetDrops.delete(n);
  if (sheets[n]) return Promise.resolve(sheets[n]);
  if (sheetLoads.has(n)) return sheetLoads.get(n);
  const url = `assets/${LITE ? 'sprites_half' : 'sprites'}/${n}.webp`;
  const viaImg = () => loadImage(url).then(async (im) => im && (BITMAP ? await createImageBitmap(im).catch(() => im) : im));
  // lite: straight from the file into one bitmap, so no <img> holds a second decoded copy
  const viaFile = () => fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => b && createImageBitmap(b));
  const load = (LITE ? viaFile().catch(viaImg) : viaImg()).catch(() => null).then((im) => {
    sheetLoads.delete(n);
    if (sheetDrops.delete(n)) { im?.close?.(); return null; }
    if (im) sheets[n] = im;
    return im;
  });
  sheetLoads.set(n, load);
  return load;
}
// the sheets a deck needs, seen from one side of the board (0 the near side, 1 the far side)
function deckSheets(deck, side) {
  const out = [], names = Object.keys(meta);
  for (const id of new Set(deck)) { const pre = `${keyOf(id)}_${facingOf(id, side)}_`; for (const n of names) if (n.startsWith(pre)) out.push(n); }
  return out;
}
// keeps exactly these sheets: frees the others and starts loading the missing ones
function keepSheets(want) {
  for (const n of Object.keys(sheets)) if (!want.has(n)) { sheets[n].close?.(); delete sheets[n]; }
  for (const n of sheetLoads.keys()) if (!want.has(n)) sheetDrops.add(n);
  for (const n of want) loadSheet(n);
}
// the wall is a token a spell makes, so no deck list names it
const tokenSheets = () => Object.keys(meta).filter((n) => n.startsWith('crystal_wall_'));
// Every device loads only the sheets both decks can summon, in the facing each side sees, and frees the last match's
// others: with 25 characters all 250 full sheets would decode to about 3.7 GB, too much for a desktop tab as well.
// A hotseat board turns to each player in turn, so there both decks are seen from both sides.
function sheetsForMatch(decks, turns = false) {
  prepared = '';
  const want = new Set(decks.flatMap((deck, p) => turns ? [...deckSheets(deck, 0), ...deckSheets(deck, 1)] : deckSheets(deck, V(p))));
  for (const n of tokenSheets()) want.add(n);
  keepSheets(want);
  return [...want];
}
// While the setup is open the decks on it load in the background, so START rarely has to wait: your deck on the near
// side and the next bot deck (picked here, used by the next bot match) on the far side.
let nextBot = null;
const takeBot = () => { const d = nextBot ?? Object.values(STARTERS)[Math.floor(Math.random() * Object.keys(STARTERS).length)].cards; nextBot = null; return d; };
let prepared = '';
function prepareDecks({ mode, deck, deck2 }) {
  // only from the title and the setup: during a match the board's own sheets stay as they are
  if (!deck?.length || ($('setup').classList.contains('hidden') && $('start').classList.contains('hidden'))) return;
  if (mode !== 'hotseat') nextBot ??= Object.values(STARTERS)[Math.floor(Math.random() * Object.keys(STARTERS).length)].cards;
  const want = new Set(mode === 'hotseat'
    ? [deck, deck2 ?? []].flatMap((d) => [...deckSheets(d, 0), ...deckSheets(d, 1)])
    : [...deckSheets(deck, 0), ...deckSheets(mode === 'bot' ? nextBot : [], 1)]);
  for (const n of tokenSheets()) want.add(n);
  const key = [...want].sort().join();
  if (key === prepared) return;
  prepared = key;
  keepSheets(want);
}
// A match waits behind the match loader until every sheet it can put on the board is in. With all of them in already
// (loaded on the title or the setup) it starts at once, and a wait under 150 ms shows no loader at all. A sheet that
// fails is tried once more; if it still fails the loader says so and offers TRY AGAIN, and the match never starts
// without it.
async function untilLoaded(names, my) {
  const box = $('matchLoad'), all = names.length;
  const missing = () => names.filter((n) => !sheets[n]);
  if (!missing().length) return;
  let shown = false;
  const draw = () => { const p = 1 - missing().length / all; box.style.setProperty('--p', p.toFixed(4)); $('matchPct').textContent = `${Math.round(p * 100)}%`; };
  const show = () => { if (shown || my !== token) return; shown = true; draw(); box.classList.remove('hidden', 'going'); };
  const showing = setTimeout(show, 150);
  for (;;) {
    await Promise.all(missing().map((n) => loadSheet(n).then((im) => im ?? (my === token ? loadSheet(n) : null)).then(() => { if (shown) draw(); })));
    if (my !== token) { clearTimeout(showing); return; }
    if (!missing().length) break;
    clearTimeout(showing);
    show();
    $('matchMsg').hidden = $('matchRetry').hidden = false;
    await new Promise((ok) => { $('matchRetry').onclick = ok; });
    $('matchMsg').hidden = $('matchRetry').hidden = true;
    if (my !== token) return;
  }
  clearTimeout(showing);
  if (!shown) return;
  draw();
  box.classList.add('going');
  await new Promise((ok) => setTimeout(ok, 300));
  if (my !== token) return;
  box.classList.add('hidden');
  box.classList.remove('going');
}
for (const n of Object.keys(vfxMeta)) if (vfxFiles.has(`${n}.webp`)) loadImage(`assets/vfx/${n}.webp`).then((im) => { if (im) vfxSheets[n] = im; });
const portraitIds = [...new Set([...POOL, 'crystal_wall_token'])];
await Promise.all(portraitIds.filter((id) => portraitFiles.has(`${id}.webp`)).map(async (id) => { const im = await loadImage(`assets/portraits/${id}.webp`); if (im) portraits[id] = im; }));
// board HUD art and the particle textures
// the HUD art is vector (SVG) where uiArt() has one: drawn once into a bitmap at up to twice its own
// size, never as an SVG image every frame
const flat = (im) => {
  if (!im.src.endsWith('.svg')) return createImageBitmap(im).catch(() => im);
  if (!im.naturalWidth) return im;
  const k = Math.max(1, Math.min(2, 512 / Math.max(im.naturalWidth, im.naturalHeight)));
  const c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  return createImageBitmap(c).catch(() => c);
};
const hudImg = {};
await Promise.all([
  FX.loadFx(loadImage),
  ...['bar_ally', 'bar_enemy', 'plaque_ally', 'plaque_enemy', 'burst_dmg', 'burst_heal', 'arrow_target', 'mana_pip', 'badge_armor', 'badge_ward', 'el_frost', 'el_fire', 'el_wild', 'el_storm', 'el_shadow', 'mark_target', 'mark_place',
    'prop_barricade', 'prop_rubble1', 'prop_rubble2', 'prop_rubble3']
    .map(async (n) => { const im = await loadImage(uiArt(n)); if (im) hudImg[n] = await flat(im); }),
  track(document.fonts?.load('40px "Latent Legends"').catch(() => {})),
  // what the title shows, decoded before the loader lifts: the key art, the logo, its buttons and the body font
  ...['assets/ui/keyart.webp', 'assets/ui/logo.webp', ...['btn_green', 'btn_blue', 'lbl_play', 'lbl_cards', 'ico_gear'].map(uiArt)]
    .map((src) => loadImage(src).then((im) => im?.decode().catch(() => {}))),
  ...['800 28px Nunito', '900 28px Nunito'].map((f) => track(document.fonts?.load(f).catch(() => {}))),
]);

// ---------- slot rings: sprites drawn on the floor, not board paint ----------
// rings.json holds each painted ring's fitted ellipse (board space). Every ring eases from its idle colour
// (blue yours, orange the enemy's) into gold, or red for an enemy target, so the two never sit on top of each other.
const RINGS = boardImg && (await getJson('assets/rings.json').catch(() => null)) || {};
const RING_R = 0.74;                        // the ring line's radius over the sprite's half width (measured on ring_slot)
const RING_COL = { ally: '#5cbcff', enemy: '#ff8c3e', gold: '#ffd34c', red: '#ff5040' };
const ringSpr = {};
await Promise.all(['ring_slot', 'ring_target', 'ring_hover'].map(async (n) => {
  const im = await loadImage(`assets/ui/${n}.webp`);
  if (!im) return;
  // the sprites are white light on black. Added onto the bright stone they wash out to white, so each one
  // becomes a coloured sprite with the light as its alpha (a whiter core where the light is strongest)
  const src = document.createElement('canvas'); src.width = src.height = 256;
  const sx = src.getContext('2d', { willReadFrequently: true });
  sx.drawImage(im, 0, 0, 256, 256);
  const base = sx.getImageData(0, 0, 256, 256).data;
  for (const [k, col] of Object.entries(RING_COL)) {
    const [r, gg, b] = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16));
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d');
    const out = x.createImageData(256, 256), d = out.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = Math.max(base[i], base[i + 1], base[i + 2]) / 255, w = 0.45 * l * l * l;
      d[i] = r + (255 - r) * w; d[i + 1] = gg + (255 - gg) * w; d[i + 2] = b + (255 - b) * w;
      d[i + 3] = Math.min(255, l * 1.35 * 255);
    }
    x.putImageData(out, 0, 0);
    ringSpr[`${n}_${k}`] = c;
  }
}));

// ---------- sound: each action plays its own clip's soundtrack, decoded in the background ----------
let actx = null, soundOn = settings.sound ?? true;
const buffers = {};
async function initAudio() {
  if (actx) return;
  actx = new AudioContext();
  // Only request listed files, a few at a time: the static server resets bursts of 100+ connections.
  const have = await listDir('assets/sfx/');
  const names = [...new Set([...Object.keys(meta), ...Object.values(vfxMeta).map((m) => m.sfx).filter(Boolean)])].filter((n) => !have.size || have.has(`${n}.m4a`));
  const load = async (n) => {
    for (let tries = 0; tries < 3 && !buffers[n]; tries++) {
      try {
        const r = await fetch(`assets/sfx/${n}.m4a`);
        if (!r.ok) return;
        buffers[n] = await actx.decodeAudioData(await r.arrayBuffer());
      } catch { await new Promise((ok) => setTimeout(ok, 300)); }
    }
  };
  const queue = names.slice();
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await load(queue.shift()); }));
}
function sfx(name, vol = 1) {
  if (!actx || !soundOn || !buffers[name]) return;
  const src = actx.createBufferSource(), gain = actx.createGain();
  src.buffer = buffers[name];
  gain.gain.value = vol;
  src.connect(gain).connect(actx.destination);
  src.start();
}

// ---------- clock ----------
let gt = 0, last = performance.now(), speed = AUTOPLAY ? 4 : [1, 2, 4].includes(settings.speed) ? settings.speed : 1;
const waiters = [];
const wait = (ms) => new Promise((r) => waiters.push({ at: gt + ms, r }));

// ---------- match state ----------
let S = null, token = 0, busy = true, autoCombat = AUTOPLAY || !!settings.autoCombat;
let views = new Map(), floats = [], effects = [], banner = null, hud = null;
let turnShown = null;   // turn, phase and Essence the HUD shows while an action plays out (null: the live state)
let shrineHp = [[9, 9, 9], [10, 10, 10]], shrineDown = [[false, false, false], [false, false, false]], shrineFlash = [[0, 0, 0], [0, 0, 0]];
let closedAt = [null, null, null];   // game time each lane was shown closing (lanes are the same on both screens)
let humanResolve = null;     // resolves the action the human picks
let selection = null;        // { kind: 'card'|'move'|'skill', id?, from?, targets: [{ shape, actions }] }
let hoverPos = null;

function snapshot(s) {
  const units = {};
  for (const lane of s.board) for (const side of lane) for (const u of side)
    if (u) units[u.uid] = { hp: u.hp, maxHp: u.maxHp, mana: u.mana, maxMana: u.maxMana, taunt: u.taunt, frozen: u.frozen, burn: u.burn, element: u.element, atk: u.atk, armor: u.armor, ward: u.ward };
  return { units, shrines: s.players.map((p) => p.shrines.slice()), essence: s.players.map((p) => p.essence), hand: s.players.map((p) => p.hand.length), deck: s.players.map((p) => p.deck.length) };
}

// meta: { card, icon } picks the portrait and the badge the battle log shows next to the line
function log(text, cls = '', meta = {}) { UI.feed(text, cls, meta); }
// the seat this screen plays (engine player 0 or 1). ME is always drawn at the bottom:
// V maps an engine side to a screen side (0 bottom, 1 top); views, rings and shrines keep screen sides
let ME = 0;
const V = (p) => p ^ ME;
// two players on one screen (hotseat): the board turns to whoever plays, so the log names seats, not sides
const HOT = () => !!match?.hotseat;
const who = (p) => (HOT() ? `Player ${p + 1}` : V(p) === 0 ? 'You' : 'Enemy');
const verb = (p, a, b) => (!HOT() && V(p) === 0 ? a : b);
const sideCls = (p) => ((HOT() ? p : V(p)) === 0 ? 'you' : 'foe');
const laneName = (l) => `lane ${l + 1}`;
const cardName = (id) => db[id]?.name ?? id;

// ---------- views ----------
const facingOf = (id, side) => (keyOf(id) === 'crystal_wall' ? 'front' : side === 0 ? 'back' : 'front');
const clipName = (v, action) => `${v.key}_${v.facing}_${action}`;
const hasClip = (v, action) => !!meta[clipName(v, action)];
const ringScale = (w) => (CHAR_H / SPRITE_H) * (w / 111);

function placeView(v, side, slot, lane) {
  const [x, y, w] = RING[side][slot][lane];
  Object.assign(v, { side, slot, lane, x, y: y + 4, s: ringScale(w), sr: w / 111 });
}
function makeView(e, u) {
  const v = {
    uid: e.uid, id: e.id, key: keyOf(e.id), facing: facingOf(e.id, V(e.p)), element: u?.element ?? db[e.id]?.element,
    anim: 'idle', t0: gt - Math.random() * 3000, born: gt, alpha: 0, flash: 0, lunge: null,
    hp: u?.hp ?? 1, maxHp: u?.maxHp ?? 1, mana: u?.mana ?? 0, maxMana: u?.maxMana ?? 0, taunt: false, frozen: false, burn: 0, dying: false,
    armor: u?.armor ?? 0, ward: u?.ward ?? 0,
    // shown HP lerps to hp; the trail holds the old value for a moment after a hit, then drains
    hpShown: u?.hp ?? 1, trail: u?.hp ?? 1, hitAt: -1e9, knock: null, mv: null,
  };
  placeView(v, V(e.p), e.slot, e.lane);
  return v;
}
function playAnim(v, action) {
  const m = meta[clipName(v, action)];
  if (!m) { v.anim = 'idle'; return { hitMs: 260, endMs: action === 'death' ? 900 : 560 }; }
  v.anim = action; v.t0 = gt;
  return { hitMs: (m.hit / m.fps) * 1000, endMs: ((action === 'death' ? m.frames : m.end + 1) / m.fps) * 1000 };
}
const headY = (v) => v.y - SPRITE_H * v.s - 6;
// kind: 'dmg' and 'heal' sit on a comic burst, 'shrine' is a bigger gold hit, 'text' is plain outlined text
function float(x, y, text, color, big = false, kind = 'text') {
  floats.push({ x, y, text, color, t0: gt, big, kind, rot: (Math.random() - 0.5) * 0.35, dx: (Math.random() - 0.5) * 30 });
}

// ---------- VFX: flipbooks from vfx.json, else a short glow ----------
function spawnVfx(id, x, y, sr, element, layer) {
  const m = vfxMeta[id];
  if (m && vfxSheets[id]) {
    const dur = (m.frames / m.fps) * 1000;
    if (m.where === 'unit') y -= CHAR_H * 0.45 * sr;   // unit effects sit on the body, slot and lane effects on the ground
    effects.push({ id, m, x, y, sr, t0: gt, dur, layer: m.layer ?? layer ?? 'top' });
    if (m.sfx) sfx(m.sfx);
    return { hitMs: m.hit != null ? (m.hit / m.fps) * 1000 : dur * 0.4, endMs: dur };
  }
  effects.push({ glow: ecol(element), x, y, sr, t0: gt, dur: 650, layer: 'top' });
  return { hitMs: 260, endMs: 650 };
}
function drawEffects(layer) {
  effects = effects.filter((f) => gt - f.t0 < f.dur);
  for (const f of effects) {
    if (f.layer !== layer) continue;
    const t = (gt - f.t0) / f.dur;
    if (f.glow) {
      const r = 30 + 110 * t;
      const grd = g.createRadialGradient(f.x, f.y - 40 * f.sr, 2, f.x, f.y - 40 * f.sr, r * f.sr);
      grd.addColorStop(0, hexA(f.glow, 0.85 * (1 - t))); grd.addColorStop(1, hexA(f.glow, 0));
      g.fillStyle = grd; g.beginPath(); g.arc(f.x, f.y - 40 * f.sr, r * f.sr, 0, Math.PI * 2); g.fill();
      continue;
    }
    const img = vfxSheets[f.id];
    if (!img) continue;
    const m = f.m, k = Math.min(m.frames - 1, Math.floor(((gt - f.t0) / 1000) * m.fps));
    const sc = m.scale ?? 1, size = m.cell * sc;
    const [ax, ay] = m.anchor ?? [m.cell / 2, m.cell / 2];
    g.save();
    if (m.blend) g.globalCompositeOperation = m.blend;
    g.drawImage(img, (k % m.cols) * m.cell, Math.floor(k / m.cols) * m.cell, m.cell, m.cell, f.x - ax * sc, f.y - ay * sc, size, size);
    g.restore();
  }
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- event playback ----------
async function playBatch(events, snap, my) {
  for (let i = 0; i < events.length && my === token;) {
    const e = events[i++];
    if (e.type === 'Attack' || e.type === 'Cast' || e.type === 'SpellCast' || e.type === 'JokerReveal') {
      const conseq = [];
      while (i < events.length && CONSEQ.has(events[i].type)) conseq.push(events[i++]);
      if (e.type === 'Attack' || e.type === 'Cast') await doAction(e, conseq);
      else await doSpell(e, conseq);
    } else if (CONSEQ.has(e.type)) {
      applyConseq(e);
      await wait(e.type === 'LaneClosed' ? 700 : e.type === 'Death' ? 500 : 380);
    } else await doEvent(e, snap);
  }
  if (my !== token) return;
  for (const [uid, u] of Object.entries(snap.units)) {
    const v = views.get(+uid);
    if (v && !v.dying) Object.assign(v, u);
  }
  // units moved by an effect without an event snap to their engine slot
  for (const v of views.values()) {
    if (v.dying) continue;
    const f = findUnit(S, v.uid);
    if (f && (f[1] !== v.lane || V(f[2]) !== v.side || f[3] !== v.slot)) placeView(v, V(f[2]), f[3], f[1]);
  }
  shrineHp = [ME, 1 - ME].map((p) => snap.shrines[p].slice());
  // a lane closed without its event shown (a resumed online match) is simply closed
  S.closed.forEach((c, lane) => { if (c && closedAt[lane] == null) closedAt[lane] = gt - 1000; });
  hud = snap;
}

async function doEvent(e, snap) {
  switch (e.type) {
    case 'TurnStart':
      turnShown = null;
      if (!HOT()) UI.banner(V(e.p) === 0 ? 'your' : 'enemy');
      UI.render();
      log(`${who(e.p)}: turn ${e.turn}, ${e.essence} Essence`, 'turn', { icon: 'turn' });
      for (const v of views.values()) if (v.side === V(e.p)) v.taunt = false;
      await wait(850);
      break;
    case 'Summon': {
      // the enemy's card flips out of their hand and dives at its slot (your own cards already flew there from the hand)
      if (V(e.p) === 1 && !e.mimic && db[e.id]?.type !== 'token') { const [rx, ry] = RING[1][e.slot][e.lane]; await UI.reveal(e.id, toCss(rx, ry - 50)); }
      const v = makeView(e, snap.units[e.uid]);
      views.set(e.uid, v);
      // its action sheets go to the GPU now, one per frame, not on the frame its first attack plays
      for (const a of ['attack', 'skill', 'hurt', 'death']) if (hasClip(v, a)) warmQueue.push(clipName(v, a));
      const el = db[e.id]?.element;
      log(`${who(e.p)} ${verb(e.p, 'summon', 'summons')} ${cardName(e.id)}${e.mimic ? ' (copy)' : ''} in ${laneName(e.lane)}`, sideCls(e.p), { card: e.id, icon: 'summon' });
      // the unit drops in (drawUnit) and the burst goes off as its feet touch the ring
      await wait(DROP_MS);
      if (el) spawnVfx(`summon_${el.toLowerCase()}`, v.x, v.y, v.sr, el, 'ground');
      FX.summonBurst(v.x, v.y, v.sr, el);
      shake(0.14);
      if (hasClip(v, 'idle')) sfx(clipName(v, 'idle'), 0.5);
      await wait(650 - DROP_MS);
      break;
    }
    case 'Move': {
      const v = views.get(e.uid);
      if (v) {
        // glide to the new slot in a short hop instead of snapping
        v.mv = { x0: v.x, y0: v.y, t0: gt, dur: 380 };
        FX.dustRing(v.x, v.y, v.sr, 5);
        placeView(v, v.side, e.slot, e.to);
      }
      log(`${NAMEV(v)} moves to ${laneName(e.to)}`, sideCls((v?.side ?? 0) ^ ME), { card: v?.id });
      await wait(400);
      if (v) FX.dustRing(v.x, v.y, v.sr, 5);
      break;
    }
    case 'ManaGain':
      for (const v of views.values()) if (v.side === e.p && !v.dying) v.mana = Math.min(v.maxMana, v.mana + 1);
      break;
    case 'Thaw': {
      const v = views.get(e.uid);
      if (v) { v.frozen = false; log(`${NAMEV(v)} thaws and skips its action`, sideCls(v.side ^ ME), { card: v.id, icon: 'freeze' }); }
      await wait(300);
      break;
    }
    case 'Burned':
      log(`${who(e.p)} ${verb(e.p, 'burn', 'burns')} ${cardName(e.id)}: hand full`, sideCls(e.p), { card: e.id, icon: 'burn' });
      break;
    case 'GameOver':
      await wait(900);
      showOver(e.winner, e.reason);
      log(`Game over: ${e.winner === 'draw' ? 'draw' : HOT() ? `${who(e.winner)} wins` : V(e.winner) === 0 ? 'you win' : 'enemy wins'}`, 'turn', { icon: 'win' });
      break;
    default:
      break;
  }
}
const NAMEV = (v) => (v ? cardName(v.id) : 'A unit');
function showOver(winner, reason) {
  guide.coach(null);
  if (HOT()) {
    if (winner !== 'draw' && winner !== ME) turnTo(winner);
    hideCover();
    return UI.over(winner === 'draw' ? 'draw' : 0, winner === 'draw' ? 'Turn limit reached and the Shrines are even.'
      : `${who(winner)} wins. ${reason === 'turnLimit' ? 'Turn limit reached: the higher total Shrine HP wins.' : `Two Shrines of ${who(1 - winner)} destroyed.`}`, [who(ME), who(1 - ME)]);
  }
  if (match?.training) {
    try { localStorage.setItem('latent.trained', 'true'); } catch {}
    return UI.over(winner === 'draw' ? 'draw' : V(winner), V(winner) === 0 ? 'Training complete. You are ready for real matches.' : 'Training over. Play it again, or try a real match.');
  }
  UI.over(winner === 'draw' ? 'draw' : V(winner), reason === 'turnLimit' ? 'Turn limit reached: the higher total Shrine HP wins.'
    : V(winner) === 0 ? 'Two enemy Shrines destroyed.' : 'Two of your Shrines fell.');
}

async function doAction(e, conseq) {
  const v = views.get(e.uid);
  const action = e.type === 'Attack' ? 'attack' : 'skill';
  if (!v) { await applyAll(conseq); return; }
  const { hitMs, endMs } = playAnim(v, hasClip(v, action) ? action : 'idle');
  if (hasClip(v, action)) sfx(clipName(v, action));
  const dmg = conseq.find((c) => c.type === 'Damage' && c.src === e.uid);
  const sh = conseq.find((c) => c.type === 'ShrineHit');
  let tx = null, ty = null;
  if (dmg && views.get(dmg.uid)) ({ x: tx, y: ty } = views.get(dmg.uid));
  else if (sh) [tx, ty] = SHRINE[V(sh.side)][sh.lane];
  const ranged = RANGED.has(db[v.id]?.role);
  if (tx !== null) {
    // Back units only lean in; Front units step into the blow
    const dx = tx - v.x, dy = ty - v.y, d = Math.hypot(dx, dy) || 1, k = Math.min(ranged ? 0.08 : 0.25, (ranged ? 24 : 60) / d);
    v.lunge = { t0: gt, hitMs, endMs, dx: dx * k, dy: dy * k };
  }
  if (!hasClip(v, action)) effects.push({ glow: ecol(v.element), x: v.x, y: v.y, sr: v.sr, t0: gt, dur: 500, layer: 'top' });
  if (action === 'attack') log(`${NAMEV(v)} attacks${sh ? ' the Shrine' : dmg ? ` ${NAMEV(views.get(dmg.uid))}` : ''} in ${laneName(v.lane)}`, sideCls(v.side ^ ME), { card: v.id, icon: sh ? 'shrine' : 'attack' });
  else log(`${NAMEV(v)} uses ${SKILL_NAME[e.skill] ?? e.skill} (${e.manaSpent} Mana)`, sideCls(v.side ^ ME), { card: v.id, icon: 'spell' });
  v.mana = Math.max(0, v.mana - (e.manaSpent || 0));
  if (e.skill === 'blast') {
    const foe = 1 - v.side, a = RING[foe][0][v.lane], b = RING[foe][1][v.lane];
    const el = (v.element ?? 'Fire').toLowerCase();
    v.blast = { id: vfxMeta[`blast_${el}`] ? `blast_${el}` : 'blast_fire', x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 + 30 };
  }
  await wait(hitMs * 0.6);
  if (v.blast) { spawnVfx(v.blast.id, v.blast.x, v.blast.y, 1, v.element, 'top'); FX.castBurst(v.blast.x, v.blast.y, v.element, true); shake(0.25); v.blast = null; }
  // a Back unit's shot flies to the target and lands on the hit frame
  else if (ranged && tx !== null) {
    const travel = Math.max(80, hitMs * 0.4), sx = v.x, sy = v.y - CHAR_H * 0.6 * v.sr, ey = ty - (sh ? 10 : CHAR_H * 0.45);
    const vx = ((tx - sx) * 1000) / travel, vy = ((ey - sy) * 1000) / travel;
    const [bolt, glow] = BOLT[v.element] ?? ['star', 'glowGold'];
    FX.emit({ tex: bolt, x: sx, y: sy, vx, vy, life: travel, s0: 34, s1: 40, a: 1, fade: 0.05, stretch: 1.4 });
    FX.emit({ tex: glow, x: sx, y: sy, vx, vy, life: travel, s0: 60, s1: 70, a: 0.8, fade: 0.05 });
  }
  await wait(hitMs * 0.4);
  await applyAll(conseq);
  await wait(Math.max(300, endMs - hitMs));
}

// a Back unit's shot: its spark and glow by element
const BOLT = { Fire: ['flame', 'glowRed'], Frost: ['shard', 'glowBlue'], Wild: ['dust', 'glowGreen'], Storm: ['flare', 'glowYellow'], Shadow: ['rune', 'glowViolet'] };
// spells aimed at an enemy unit; the other targeted spells (Thorns, Regrowth, Mirror) land on your own unit
const FOE_TARGET = new Set(['fireball', 'chain_lightning', 'void_bolt', 'gust']);
// spells whose effect sits on the ground of a lane instead of rising from a unit
const GROUND = new Set(['lava_pool', 'frost_nova', 'crystal_wall', 'gravity_well']);
function spellPos(e) {
  const me = V(e.p), foe = 1 - me;
  if (e.target) {
    const side = FOE_TARGET.has(e.id) ? foe : me;
    const [x, y, w] = RING[side][e.target.slot][e.target.lane];
    return [x, y, w / 111];
  }
  if (e.id === 'crystal_wall') { const [x, y, w] = RING[me][0][e.lane]; return [x, y, w / 111]; }
  // Swap: between the two units it trades; Mimic: on your own lane where the copy appears
  if (e.id === 'swap') { const a = RING[me][e.slot][e.lanes[0]], b = RING[me][e.slot][e.lanes[1]]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 222]; }
  if (e.id === 'mimic') { const a = RING[me][0][e.lane], b = RING[me][1][e.lane]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 222]; }
  if (e.lane != null) {
    const a = RING[foe][0][e.lane], b = RING[foe][1][e.lane];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 30, (a[2] + b[2]) / 222];
  }
  return [768, me === 0 ? 540 : 250, 1];
}

async function doSpell(e, conseq) {
  const c = db[e.id];
  const [x, y, sr] = spellPos(e);
  if (V(e.p) === 1) await UI.reveal(e.id, toCss(x, y - 40));
  { const [nx, ny] = toCss(x, y - 150 * sr); UI.spellName(c?.name ?? e.id, nx, ny, ecol(c?.element ?? e.element), c ? `name_${e.id}` : null); }
  log(`${who(e.p)} ${verb(e.p, 'play', 'plays')} ${c?.name ?? e.id}${e.element ? ` (${e.element})` : ''}`, sideCls(e.p), { card: e.id, icon: 'spell' });
  const ground = GROUND.has(e.id);
  const { hitMs, endMs } = spawnVfx(e.id, x, y, sr, c?.element ?? 'Neutral', ground ? 'ground' : 'top');
  await wait(Math.max(250, hitMs));
  const el = e.element ?? c?.element;
  FX.castBurst(x, y - (ground ? 0 : 40), el, FOE_TARGET.has(e.id) || ground);
  if (FOE_TARGET.has(e.id) || e.id === 'lava_pool' || e.id === 'frost_nova' || e.id === 'gravity_well') shake(0.3);
  await applyAll(conseq);
  syncBoard();
  const foe = 1 - V(e.p);
  if (e.id === 'frost_nova' || e.id === 'lava_pool')
    for (const v of views.values()) if (v.side === foe && v.lane === e.lane && !v.dying) {
      if (e.id === 'frost_nova') v.frozen = true; else v.burn = 2;
      v.flash = 0.8;
    }
  if (e.id === 'mirror' && e.target) {
    const f = S.board[e.target.lane][e.p][e.target.slot];
    const v = f && views.get(f.uid);
    if (v) { v.element = e.element; v.flash = 1; float(v.x, headY(v), e.element, ecol(e.element)); }
  }
  if (e.id === 'spark') float(768, V(e.p) === 0 ? 520 : 240, '+1 Essence', '#ffd166', true);
  await wait(Math.max(250, Math.min(900, endMs - hitMs)));
}

// Gust, Gravity Well and Swap move units, Regrowth and Thorns change them, without events of their own: after a spell
// every view glides to where the engine has its unit and takes its numbers
function syncBoard() {
  for (let lane = 0; lane < 3; lane++)
    for (const p of [0, 1])
      for (let slot = 0; slot < 2; slot++) {
        const u = S.board[lane][p][slot], v = u && views.get(u.uid);
        if (!v || v.dying) continue;
        if (v.lane !== lane || v.slot !== slot) {
          v.mv = { x0: v.x, y0: v.y, t0: gt, dur: 380 };
          FX.dustRing(v.x, v.y, v.sr, 5);
          placeView(v, v.side, slot, lane);
        }
        if (v.maxHp !== u.maxHp) { v.maxHp = u.maxHp; v.hp = u.hp; }
        if (v.thorns !== u.thorns && u.thorns > 0) FX.auraPulse(v.x, v.y, v.sr, 'Wild');
        v.thorns = u.thorns;
      }
}

// the hit lands first; a lane that closes because of it closes a beat later, then its units slide out one by one
async function applyAll(conseq) {
  conseq.filter((c) => !LANE_EV.has(c.type)).forEach(applyConseq);
  const later = conseq.filter((c) => LANE_EV.has(c.type));
  if (!later.length) return;
  await wait(650);
  for (const c of later) { applyConseq(c); await wait(c.type === 'LaneClosed' ? 700 : 420); }
}

function applyConseq(c) {
  switch (c.type) {
    case 'LaneClosed': {
      closedAt[c.lane] = gt;
      const [x, y] = laneMid(c.lane);
      shake(0.45);
      FX.dustRing(x, y, 1.5, 10);
      { const [nx, ny] = toCss(x, y - 80); UI.spellName('LANE CLOSED', nx, ny, '#d8c8a8', 'lbl_lane_closed'); }
      log(`Lane ${c.lane + 1} is closed`, 'turn', { icon: 'shrine' });
      break;
    }
    case 'Relocate': {
      const v = views.get(c.uid);
      if (!v) break;
      FX.dustRing(v.x, v.y, v.sr, 5);
      v.mv = { x0: v.x, y0: v.y, t0: gt, dur: 560 };
      placeView(v, V(c.p), c.slot, c.toLane);
      log(`${NAMEV(v)} moves to ${laneName(c.toLane)}`, sideCls(v.side ^ ME), { card: v.id });
      break;
    }
    case 'Recall': {
      // back to hand (or lost when the hand is full): the unit lifts off its ring and fades
      const v = views.get(c.uid);
      if (!v) break;
      Object.assign(v, { dying: true, recall: gt, taunt: false, frozen: false, burn: 0, removeAt: gt + 700 });
      FX.auraPulse(v.x, v.y, v.sr, v.element);
      log(c.lost ? `${NAMEV(v)} is lost: hand full` : `${NAMEV(v)} returns to ${HOT() ? `${who(c.p)}'s` : V(c.p) === 0 ? 'your' : 'the enemy'} hand`,
        sideCls(v.side ^ ME), { card: v.id, icon: c.lost ? 'burn' : 'summon' });
      break;
    }
    case 'Damage': {
      const v = views.get(c.uid);
      if (!v) return;
      v.hp = Math.max(0, v.hp - c.dmg);
      v.flash = 1; v.hitAt = gt;
      // push the target away from whoever hit it (spells come from the caster's side)
      const src = views.get(c.src);
      let dx = 0, dy = v.side === 1 ? -1 : 1;
      if (src && src !== v) { const d = Math.hypot(v.x - src.x, v.y - src.y) || 1; dx = (v.x - src.x) / d; dy = (v.y - src.y) / d; }
      v.knock = { t0: gt, dx: dx * (10 + c.dmg * 2) * v.sr, dy: dy * (6 + c.dmg) * v.sr };
      FX.hitImpact(v.x, v.y - CHAR_H * 0.45 * v.sr, dx, dy, c.dmg, c.kind, src?.element);
      shake(0.12 + Math.min(0.3, c.dmg * 0.035));
      FX.hitstop((45 + Math.min(65, c.dmg * 9)) / Math.sqrt(speed));
      float(v.x, headY(v) - 6, `-${c.dmg}`, c.kind === 'pure' ? '#e7ccff' : c.kind === 'magic' ? '#ffe08a' : '#ffffff', true, 'dmg');
      if (v.hp > 0) { playAnim(v, 'hurt'); if (hasClip(v, 'hurt')) sfx(clipName(v, 'hurt'), 0.8); }
      break;
    }
    case 'Death': {
      const v = views.get(c.uid);
      if (!v) return;
      v.dying = true; v.taunt = false; v.frozen = false; v.burn = 0;
      FX.deathBurst(v.x, v.y, v.sr, v.element);
      shake(0.28);
      const { endMs } = playAnim(v, 'death');
      if (hasClip(v, 'death')) sfx(clipName(v, 'death'));
      log(`${NAMEV(v)} falls`, sideCls(v.side ^ ME), { card: v.id, icon: 'death' });
      v.removeAt = gt + endMs + 700;
      break;
    }
    case 'ShrineHit': {
      shrineHp[V(c.side)][c.lane] = Math.max(0, shrineHp[V(c.side)][c.lane] - c.dmg);
      shrineFlash[V(c.side)][c.lane] = 1;
      const [x, y] = SHRINE[V(c.side)][c.lane];
      FX.shrineHit(x, y - 10, V(c.side), c.dmg);
      shake(0.35 + Math.min(0.35, c.dmg * 0.05));
      FX.hitstop(90 / Math.sqrt(speed));
      float(x, y - 30, `-${c.dmg}`, '#ffe066', true, 'shrine');
      break;
    }
    case 'ShrineDown':
      shrineDown[V(c.side)][c.lane] = true;
      FX.shrineFall(...SHRINE[V(c.side)][c.lane], V(c.side));
      shake(0.85);
      FX.hitstop(150 / Math.sqrt(speed));
      { const [sx, sy] = SHRINE[V(c.side)][c.lane], [nx, ny] = toCss(sx, sy + (V(c.side) === 0 ? -120 : 90)); UI.spellName('SHRINE DOWN!', nx, ny, '#ffd36a', 'lbl_shrine_down'); }
      log(`${HOT() ? `${who(c.side)}'s` : V(c.side) === 0 ? 'Your' : 'Enemy'} Shrine in ${laneName(c.lane)} is destroyed`, 'turn', { icon: 'shrine' });
      break;
    case 'Status': {
      const v = views.get(c.uid);
      if (v && c.kind === 'taunt') { v.taunt = true; FX.auraPulse(v.x, v.y, v.sr, v.element); }
      break;
    }
    case 'Heal': {
      const v = views.get(c.uid);
      if (v) {
        v.hp = Math.min(v.maxHp, v.hp + c.amount);
        float(v.x, headY(v) - 6, `+${c.amount}`, '#ffffff', true, 'heal');
        spawnVfx('heal', v.x, v.y, v.sr, 'Wild', 'top');
        FX.healBurst(v.x, v.y - CHAR_H * 0.45 * v.sr, v.sr);
      }
      break;
    }
  }
}

// ---------- drawing ----------
function spriteFrame(v) {
  const name = clipName(v, v.anim), m = meta[name];
  if (!m) return null;
  if (!sheets[name]) { loadSheet(name); return null; }   // a copy (Mimic) can bring a character no deck list named
  let k = Math.floor(((gt - v.t0) / 1000) * m.fps);
  if (v.anim === 'idle') k = ((k % (m.frames - 1)) + (m.frames - 1)) % (m.frames - 1);
  else if (v.anim === 'death') k = Math.min(k, m.frames - 1);
  else if (k > m.end) { v.anim = 'idle'; v.t0 = gt; return spriteFrame(v); }
  return { img: sheets[name], m, k };
}

// attack: lean back for the wind-up, snap forward onto the hit frame, ease home
function lungeOffset(v) {
  const L = v.lunge;
  if (!L) return [0, 0];
  const t = gt - L.t0, wind = L.hitMs * 0.45, back = (L.endMs - L.hitMs) * 0.6;
  let f;
  if (t < wind) f = -0.22 * Math.sin(((t / wind) * Math.PI) / 2);
  else if (t < L.hitMs) { const u = (t - wind) / (L.hitMs - wind); f = -0.22 + 1.22 * u * u * u; }
  else if (t < L.hitMs + back) { const u = (t - L.hitMs) / back; f = 1 - u * u * (3 - 2 * u); }
  else { v.lunge = null; return [0, 0]; }
  return [L.dx * f, L.dy * f];
}
// a hit shoves the target away, then it springs back
function knockOffset(v) {
  const k = v.knock;
  if (!k) return [0, 0];
  const t = gt - k.t0;
  if (t > 420) { v.knock = null; return [0, 0]; }
  const f = t < 50 ? t / 50 : Math.exp(-(t - 50) / 90) * Math.cos((t - 50) / 70);
  return [k.dx * f, k.dy * f];
}
// Move: a short hop from the old slot to the new one
function moveOffset(v) {
  const m = v.mv;
  if (!m) return [0, 0];
  const u = (gt - m.t0) / m.dur;
  if (u >= 1) { v.mv = null; return [0, 0]; }
  const e = u * u * (3 - 2 * u);
  return [(m.x0 - v.x) * (1 - e), (m.y0 - v.y) * (1 - e) - Math.sin(Math.PI * u) * 28 * v.sr];
}

// one frame of a sheet recoloured flat (hit flash, frost, hover outline); the canvas is reused per call
const tintCanvas = document.createElement('canvas'), tg = tintCanvas.getContext('2d');
function silhouette(img, sx, sy, cell, color) {
  if (tintCanvas.width !== cell) tintCanvas.width = tintCanvas.height = cell;
  tg.globalCompositeOperation = 'source-over';
  tg.clearRect(0, 0, cell, cell);
  tg.drawImage(img, sx, sy, cell, cell, 0, 0, cell, cell);
  tg.globalCompositeOperation = 'source-in';
  tg.fillStyle = color; tg.fillRect(0, 0, cell, cell);
  return tintCanvas;
}

let hovered = null;   // the unit under the pointer this frame

function drawUnit(v) {
  const [lx, ly] = lungeOffset(v), [kx, ky] = knockOffset(v), [mx, my] = moveOffset(v);
  const ox = lx + kx + mx, oy = ly + ky + my - (v.recall ? Math.min(1, (gt - v.recall) / 700) ** 1.5 * 70 * v.sr : 0);
  v.alpha = v.dying && v.removeAt && gt > v.removeAt - 700 ? Math.max(0, (v.removeAt - gt) / 700) : Math.min(1, (gt - v.born) / 160);
  // summon: fall onto the ring, then squash and wobble back into shape
  const ta = gt - v.born;
  let drop = 0, sqx = 1, sqy = 1;
  if (!v.dying && ta < DROP_MS) { const u = ta / DROP_MS; drop = -150 * v.sr * (1 - u * u); sqx = 0.92; sqy = 1.1; }
  else if (!v.dying && ta < DROP_MS + 480) {
    const u = (ta - DROP_MS) / 480, w = Math.exp(-5 * u) * Math.cos(u * 15);
    sqx = 1 + 0.16 * w; sqy = 1 - 0.2 * w;
  }
  const px = v.x + ox, py = v.y + oy;
  g.save();
  g.globalAlpha = v.alpha;
  // contact shadow, smaller while the unit is in the air
  const air = Math.min(1, -drop / (150 * v.sr)) * 0.5;
  g.fillStyle = 'rgba(0,0,0,0.42)';
  g.beginPath(); g.ellipse(px, v.y + my, 44 * v.sr * (1 - air), 13 * v.sr * (1 - air), 0, 0, Math.PI * 2); g.fill();
  if (v.taunt) {
    const p = 0.5 + 0.5 * Math.sin(gt / 180);
    if (FX.fxTex.glowBlue) {
      g.globalCompositeOperation = 'lighter'; g.globalAlpha = v.alpha * (0.35 + 0.25 * p);
      g.drawImage(FX.fxTex.glowBlue, px - 90 * v.sr, v.y - 34 * v.sr, 180 * v.sr, 68 * v.sr);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = v.alpha;
    }
    g.strokeStyle = `rgba(150,215,255,${0.6 + 0.4 * p})`; g.lineWidth = 4;
    g.beginPath(); g.ellipse(px, v.y, 60 * v.sr, 21 * v.sr, 0, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2; g.beginPath(); g.ellipse(px, v.y, (70 + 4 * p) * v.sr, (25 + 1.5 * p) * v.sr, 0, 0, Math.PI * 2); g.stroke();
  }
  const fr = spriteFrame(v);
  if (fr) {
    const { img, m, k } = fr;
    // c is the cell in this sheet's own pixels: half of m.cell on the half-size sheets, drawn at the same size
    const c = m.cell * (img.width / (m.cols * m.cell)), size = m.cell * v.s, sx = (k % m.cols) * c, sy = Math.floor(k / m.cols) * c;
    // drawn around the feet so the squash keeps them planted
    g.translate(px, py + drop); g.scale(sqx, sqy);
    const x = -m.pivot[0] * v.s, y = -m.pivot[1] * v.s;
    if (v === hovered && !v.dying) {
      const sil = silhouette(img, sx, sy, c, '#ffd36b');
      g.globalAlpha = v.alpha * 0.8;
      for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) g.drawImage(sil, x + dx, y + dy, size, size);
      g.globalAlpha = v.alpha;
    }
    g.drawImage(img, sx, sy, c, c, x, y, size, size);
    if (v.frozen) {
      g.globalAlpha = v.alpha * (0.34 + 0.06 * Math.sin(gt / 300));
      g.drawImage(silhouette(img, sx, sy, c, '#a8e4ff'), x, y, size, size);
    }
    if (v.burn > 0) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = v.alpha * (0.14 + 0.1 * Math.sin(gt / 70) * Math.sin(gt / 43));
      g.drawImage(silhouette(img, sx, sy, c, '#ff7a2a'), x, y, size, size);
      g.globalCompositeOperation = 'source-over';
    }
    if (v.flash > 0.03) {
      g.globalAlpha = v.alpha * Math.min(1, v.flash) * 0.9;
      g.drawImage(silhouette(img, sx, sy, c, '#ffffff'), x, y, size, size);
    }
  } else {
    drawFallback(v, ox, oy + drop);
  }
  v.flash *= 0.84;
  g.restore();
}

// a unit without sheets yet: its portrait as a standee, else a disc with initials
function drawFallback(v, ox, oy) {
  const x = v.x + ox, y = v.y + oy, h = CHAR_H * v.sr;
  const im = portraits[v.id];
  if (im) {
    const dh = h / 0.82, dw = dh * (im.width / im.height);
    g.drawImage(im, x - dw / 2, y - dh * 0.95, dw, dh);
    if (v.flash > 0.02 || v.frozen) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = v.alpha * Math.max(v.flash * 0.5, v.frozen ? 0.25 : 0); g.drawImage(im, x - dw / 2, y - dh * 0.95, dw, dh); }
    return;
  }
  const col = ecol(v.element);
  g.fillStyle = hexA(col, 0.85);
  roundRect(x - 26 * v.sr, y - h * 0.62, 52 * v.sr, h * 0.62, 18 * v.sr); g.fill();
  g.beginPath(); g.arc(x, y - h * 0.78, 30 * v.sr, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff8'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#1a120c'; g.font = `800 ${Math.round(20 * v.sr)}px Cinzel, serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(cardName(v.id).split(' ').map((w) => w[0]).join('').slice(0, 2), x, y - h * 0.78);
  if (v.flash > 0.02) { g.fillStyle = `rgba(255,255,255,${v.flash * 0.5})`; g.beginPath(); g.arc(x, y - h * 0.5, 40 * v.sr, 0, Math.PI * 2); g.fill(); }
}

const HP_COL = (r) => (r > 0.6 ? ['#6cf06a', '#2fae45'] : r > 0.3 ? ['#ffe061', '#e0a321'] : ['#ff7a5a', '#d13b25']);
function outlinedText(text, x, y, size, fill, stroke = '#1b0f08') {
  g.font = `${size}px "Latent Legends", "Lilita One", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = Math.max(3, size * 0.24); g.strokeStyle = stroke; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}

function drawHud(v) {
  if (v.dying || v.alpha < 0.5 || v.maxHp <= 0) return;
  // the shown HP eases to the real one; after a hit the pale trail holds, then drains
  v.hpShown += (v.hp - v.hpShown) * 0.25;
  if (v.hp >= v.trail) v.trail = v.hpShown;
  else if (gt - v.hitAt > 380) v.trail += (v.hpShown - v.trail) * 0.12;
  // bar_ally / bar_enemy are 640x118; the inner trough the HP fills is x 81 to 561, y 41 to 83 of that
  const w = 124 * v.sr, h = (w * 118) / 640;
  const bx = v.x - w / 2, by = v.side === 1 ? headY(v) - 12 - h : v.y + 18;
  const tx = bx + (w * 81) / 640, ty = by + (h * 41) / 118, tw = (w * 480) / 640, th = (h * 42) / 118;
  const r = Math.max(0, Math.min(1, v.hpShown / v.maxHp)), rt = Math.max(0, Math.min(1, v.trail / v.maxHp));
  g.fillStyle = 'rgba(12,10,14,0.88)'; g.fillRect(tx, ty, tw, th);
  if (rt > r) { g.fillStyle = '#fff1b8'; g.fillRect(tx + tw * r, ty, tw * (rt - r), th); }
  const [c1, c2] = HP_COL(v.hp / v.maxHp);
  g.fillStyle = c2; g.fillRect(tx, ty, tw * r, th);
  g.fillStyle = c1; g.fillRect(tx, ty, tw * r, th * 0.55);
  g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillRect(tx, ty + th * 0.1, tw * r, th * 0.16);
  const frame = hudImg[v.side === 0 ? 'bar_ally' : 'bar_enemy'];
  if (frame) g.drawImage(frame, bx, by, w, h);
  outlinedText(`${Math.max(0, v.hp)}`, v.x, by + h * 0.52, Math.round(22 * v.sr), '#ffffff');
  // element at the left end of the bar
  const el = hudImg[`el_${(v.element ?? '').toLowerCase()}`] ?? null;
  if (el) { const s = 26 * v.sr; g.drawImage(el, bx - s * 0.5, by + h / 2 - s / 2, s * (el.width / el.height), s); }
  // armour and ward chips at the right end
  let cx = bx + w + 2 * v.sr;
  for (const [key, val] of [['badge_armor', v.armor], ['badge_ward', v.ward]]) {
    if (!val || !hudImg[key]) continue;
    const s = 26 * v.sr;
    g.drawImage(hudImg[key], cx - s * 0.4, by + h / 2 - s / 2, s * 0.9, s);
    outlinedText(`${val}`, cx + s * 0.05, by + h / 2 + 1, Math.round(15 * v.sr), '#ffffff');
    cx += s * 0.85;
  }
  // mana droplets on the far side of the bar from the body
  if (v.maxMana > 0 && hudImg.mana_pip) {
    const ph = 15 * v.sr, pw = (ph * hudImg.mana_pip.width) / hudImg.mana_pip.height, gap = pw + 3 * v.sr;
    const py = v.side === 1 ? by - ph - 1 : by + h + 1;
    for (let i = 0; i < v.maxMana; i++) {
      g.globalAlpha = i < v.mana ? 1 : 0.28;
      g.drawImage(hudImg.mana_pip, v.x - ((v.maxMana - 1) * gap) / 2 + i * gap - pw / 2, py, pw, ph);
    }
    g.globalAlpha = 1;
  }
  // statuses bob beside the head
  const icons = [];
  if (v.frozen) icons.push([hudImg.el_frost, '']);
  if (v.burn > 0) icons.push([hudImg.el_fire, `${v.burn}`]);
  if (v.thorns > 0) icons.push([hudImg.el_wild, v.thorns > 1 ? `${v.thorns}` : '']);
  icons.forEach(([im, n], i) => {
    if (!im) return;
    const s = (30 + 3 * Math.sin(gt / 220 + i)) * v.sr, x = v.x + 48 * v.sr, y = headY(v) + 40 * v.sr + i * 32 * v.sr;
    if (n) g.globalAlpha = 0.75 + 0.25 * Math.sin(gt / 60);   // the burn icon flickers
    g.drawImage(im, x - s * 0.45, y - s / 2, s * (im.width / im.height), s);
    g.globalAlpha = 1;
    if (n) outlinedText(n, x + s * 0.35, y + s * 0.3, Math.round(15 * v.sr), '#ffffff');
  });
  if (v.frozen && Math.random() < 0.05)
    FX.emit({ tex: 'snow', x: v.x + (Math.random() - 0.5) * 70 * v.sr, y: headY(v) + 30, vx: (Math.random() - 0.5) * 10, vy: 22, life: 900, s0: 11, s1: 4, a: 0.8, vr: 1 });
}

let crater = null;
function drawShrines() {
  crater ??= (() => {
    const c = document.createElement('canvas'); c.width = c.height = 160;
    const b = c.getContext('2d'), r = b.createRadialGradient(80, 80, 6, 80, 80, 80);
    r.addColorStop(0, 'rgba(12,9,8,0.92)'); r.addColorStop(0.55, 'rgba(25,18,14,0.6)'); r.addColorStop(1, 'rgba(25,18,14,0)');
    b.fillStyle = r; b.fillRect(0, 0, 160, 160);
    return c;
  })();
  FX.setShrines(shrineDown);
  for (const side of [0, 1])
    for (let lane = 0; lane < 3; lane++) {
      const [x, y] = SHRINE[side][lane];
      const down = shrineDown[side][lane];
      if (down) g.drawImage(crater, x - 90, y - 60, 180, 120);
      const f = shrineFlash[side][lane];
      if (f > 0.02 && FX.fxTex.glow) {
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.9 * f;
        g.drawImage(FX.fxTex.glow, x - 110, y - 120, 220, 220);
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        shrineFlash[side][lane] *= 0.9;
      }
      // the HP plaque sits on the player's pedestal (the hand covers what is below it) and under the enemy's
      const pl = hudImg[side === 0 ? 'plaque_ally' : 'plaque_enemy'];
      if (!pl) continue;
      const hp = shrineHp[side][lane], low = !down && hp <= 3;
      const k = low ? 1 + 0.08 * Math.sin(gt / 120) : 1 + 0.3 * f;
      // the player's plaque grows upward from a fixed bottom edge, so it never reaches below the pedestal
      const pw = 46 * k, ph = (pw * pl.height) / pl.width, cx = x, cy = side === 0 ? y + 50 - ph / 2 : y + 66;
      g.globalAlpha = down ? 0.5 : 1 - 0.4 * closedFade(lane);
      g.drawImage(pl, cx - pw / 2, cy - ph / 2, pw, ph);
      g.globalAlpha = 1;
      outlinedText(down ? 'X' : `${hp}`, cx, cy - 3, Math.round((down ? 22 : 26) * k), down ? '#a39a92' : low ? '#ffd2c4' : '#ffffff');
    }
}

const easeOutBack = (u) => 1 + 2.9 * Math.pow(u - 1, 3) + 1.9 * Math.pow(u - 1, 2);
function drawFloats() {
  floats = floats.filter((f) => gt - f.t0 < 1200);
  for (const f of floats) {
    const t = (gt - f.t0) / 1200;
    // pop in with an overshoot, hold, then drift up and fade
    const pop = t < 0.12 ? easeOutBack(t / 0.12) : 1;
    const a = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
    g.save();
    g.globalAlpha = Math.max(0, a);
    g.translate(f.x + f.dx * t, f.y - 46 * Math.pow(t, 0.7));
    if (f.kind !== 'text') g.rotate(f.rot * (1 - t));
    g.scale(pop, pop);
    if (f.kind === 'text') outlinedText(f.text, 0, 0, f.big ? 34 : 26, f.color);
    else {
      const im = hudImg[f.kind === 'heal' ? 'burst_heal' : 'burst_dmg'];
      const bw = f.kind === 'shrine' ? 108 : 86, bh = im ? (bw * im.height) / im.width : bw * 0.75;
      if (im) g.drawImage(im, -bw / 2, -bh / 2, bw, bh);
      outlinedText(f.text, 0, 2, f.kind === 'shrine' ? 40 : 34, f.color);
    }
    g.restore();
  }
}

function roundRect(x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// ---------- targets: every legal action becomes a clickable shape on the board ----------
function unitShape(side, lane, slot) {
  const [x, y, w] = RING[side][slot][lane];
  const sr = w / 111;
  return { kind: side === 1 ? 'enemy' : 'ally', x, y, sr, hit: { x0: x - 55 * sr, x1: x + 55 * sr, y0: y - CHAR_H * sr - 10, y1: y + 28 * sr } };
}
function slotShape(side, slot, lane) {
  const [x, y, w] = RING[side][slot][lane];
  const sr = w / 111;
  return { kind: 'slot', x, y, sr, hit: { x0: x - 70 * sr, x1: x + 70 * sr, y0: y - 60 * sr, y1: y + 36 * sr } };
}
function laneShape(side, lane) {
  const a = RING[side][0][lane], b = RING[side][1][lane];
  const x = (a[0] + b[0]) / 2, y0 = Math.min(a[1], b[1]) - 150, y1 = Math.max(a[1], b[1]) + 40;
  return { kind: 'lane', x, y: (y0 + y1) / 2, w: 230, y0, y1, sr: 1, hit: { x0: x - 115, x1: x + 115, y0, y1 } };
}
const shapeKey = (s) => `${s.kind}:${Math.round(s.x)}:${Math.round(s.y)}`;

// every legal action under the board shape it is dropped on; a shape holding several actions opens the chooser
function targetsFor(actions) {
  const out = new Map();
  const add = (shape, a) => {
    if (!shape) return;
    const k = shapeKey(shape);
    if (!out.has(k)) out.set(k, { shape, actions: [] });
    out.get(k).actions.push(a);
  };
  for (const a of actions) {
    if (a.t === 'move') add(slotShape(0, a.slot, a.to), a);
    else if (a.t === 'act') add(a.target ? unitShape(1, a.target.lane, a.target.slot) : null, a);
    else if (a.t === 'play') {
      const c = db[a.id];
      if (c.type === 'unit') add(slotShape(0, slotFor(c.role), a.lane), a);
      else if (a.id === 'crystal_wall') add(slotShape(0, 0, a.lane), a);
      // the copy lands in your own empty slot of the copied character's row
      else if (a.id === 'mimic') add(slotShape(0, slotFor(db[S.lastUnit].role), a.lane), a);
      // either unit of the pair takes the card; a middle unit with two partners asks which way
      else if (a.id === 'swap') for (const lane of a.lanes) add({ ...unitShape(0, lane, a.slot), lane }, a);
      else if (a.target) add({ ...unitShape(FOE_TARGET.has(a.id) ? 1 : 0, a.target.lane, a.target.slot), lane: a.target.lane }, a);
      else if (a.lane != null) add(laneShape(1, a.lane), a);
    }
  }
  return [...out.values()];
}

// ---------- closed lanes: the lane darkens, rubble covers its rings and a barricade drops across it ----------
const laneMid = (lane) => { const a = RING[0][0][lane], b = RING[1][0][lane]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
const closedFade = (lane) => (closedAt[lane] == null ? 0 : Math.max(0, Math.min(1, (gt - closedAt[lane]) / 650)));
let laneShade = null;
function makeLaneShade(lane) {
  // a soft band from the enemy Shrine down to yours, drawn once per lane
  const [tx, ty] = SHRINE[1][lane], [bx, by] = SHRINE[0][lane];
  const at = (y) => tx + ((bx - tx) * (y - ty)) / (by - ty);
  const y0 = 20, y1 = 740, hw0 = 112, hw1 = 168, pad = 40;
  const x0 = Math.min(at(y0) - hw0, at(y1) - hw1) - pad, x1 = Math.max(at(y0) + hw0, at(y1) + hw1) + pad;
  const c = document.createElement('canvas');
  c.width = Math.ceil(x1 - x0); c.height = y1 - y0 + 2 * pad;
  const b = c.getContext('2d');
  b.filter = 'blur(18px)';
  b.fillStyle = 'rgba(12,8,22,0.5)';
  b.beginPath();
  b.moveTo(at(y0) - hw0 - x0, pad); b.lineTo(at(y0) + hw0 - x0, pad);
  b.lineTo(at(y1) + hw1 - x0, c.height - pad); b.lineTo(at(y1) - hw1 - x0, c.height - pad);
  b.closePath(); b.fill();
  return { c, x: x0, y: y0 - pad };
}
function drawClosedLanes() {
  for (let lane = 0; lane < 3; lane++) {
    const f = closedFade(lane);
    if (f <= 0) continue;
    laneShade ??= [0, 1, 2].map(makeLaneShade);
    const sh = laneShade[lane];
    g.globalAlpha = f;
    g.drawImage(sh.c, sh.x, sh.y);
    for (const k in RINGS) {
      if (+k[2] !== lane) continue;
      const [x, y, rx] = RINGS[k], im = hudImg[`prop_rubble${1 + ((+k[0] * 2 + +k[1] + lane) % 3)}`];
      if (!im) continue;
      const w = rx * 2.5, h = (w * im.height) / im.width;
      g.drawImage(im, x - w / 2, y - h * 0.56, w, h);
    }
    const bar = hudImg.prop_barricade;
    if (bar) {
      // the barricade drops in with a small bounce as the lane closes
      const [x, y] = laneMid(lane), w = 290, h = (w * bar.height) / bar.width;
      const u = Math.min(1, (gt - closedAt[lane]) / 460), drop = (1 - easeOutBack(u)) * -70;
      g.globalAlpha = Math.min(1, f * 2);
      g.drawImage(bar, x - w / 2, y - h * 0.72 + drop, w, h);
    }
    g.globalAlpha = 1;
  }
}

function ringKeyAt(x, y) {
  let best = null, bd = 40;
  for (const k in RINGS) { const d = Math.hypot(RINGS[k][0] - x, RINGS[k][1] - y); if (d < bd) { bd = d; best = k; } }
  return best;
}
const ringState = new Map();   // ring key -> { h: target amount, hv: hover amount, col }
let ringT = 0;
function drawRings() {
  if (!ringSpr.ring_slot_ally) return;
  const dt = Math.max(0, Math.min(0.1, (gt - ringT) / 1000)); ringT = gt;
  // which rings are lit this frame, and in which colour
  const want = new Map();
  if (selection) {
    const hotT = hoverPos ? pickTarget(hoverPos) : null;
    for (const t of selection.targets) {
      const s = t.shape, col = s.kind === 'enemy' || s.kind === 'lane' ? 'red' : 'gold';
      const keys = s.kind === 'lane' ? Object.keys(RINGS).filter((k) => k[0] === '1' && Math.abs(RINGS[k][0] - s.x) < 90) : [ringKeyAt(s.x, s.y)];
      // a shape as well as a colour (red and gold look alike to colour blind eyes): a reticle on what you hit, a plus where you place
      for (const k of keys) if (k) want.set(k, { col, hover: hotT === t || want.get(k)?.hover, mark: col === 'red' ? 'mark_target' : 'mark_place' });
    }
    const from = selection.from && views.get(selection.from);
    if (from) want.set(ringKeyAt(from.x, from.y), { col: 'gold', hover: true });
  }
  if (S && S.phase === 'combat' && S.active === ME && !busy) {
    const f = currentActor(S), v = f && views.get(f[0].uid);
    if (v && !want.has(ringKeyAt(v.x, v.y))) want.set(ringKeyAt(v.x, v.y), { col: 'gold', hover: true });
  }
  const e = 1 - Math.exp(-dt * 14), pulse = 0.5 + 0.5 * Math.sin(gt / 170);
  g.save();
  for (const k in RINGS) {
    const [x, y, rx, ry] = RINGS[k];
    const side = k[0] === '0' ? 'ally' : 'enemy';
    const w = want.get(k);
    const st = ringState.get(k) ?? { h: 0, hv: 0, col: 'gold' };
    if (w) { st.col = w.col; st.mark = w.mark ?? null; }
    st.h += ((w ? 1 : 0) - st.h) * e;
    st.hv += ((w?.hover ? 1 : 0) - st.hv) * e;
    ringState.set(k, st);
    const hw = rx / RING_R, hh = ry / RING_R, open = 1 - closedFade(+k[2]);
    if (open <= 0) continue;
    // the idle ring fades out while the target colour fades in: one ring changing colour, not two rings
    g.globalAlpha = (1 - st.h) * (side === 'ally' ? 0.95 : 0.85) * open;
    if (g.globalAlpha > 0.01) g.drawImage(ringSpr[`ring_slot_${side}`], x - hw, y - hh, hw * 2, hh * 2);
    if (st.h > 0.01) {
      g.globalAlpha = st.h;
      g.drawImage(ringSpr[`ring_slot_${st.col}`], x - hw, y - hh, hw * 2, hh * 2);
      // the chevron ring turns slowly, flattened onto the floor
      g.save();
      g.translate(x, y); g.scale(1, ry / rx); g.rotate(gt / 2400);
      g.globalAlpha = st.h * (0.5 + 0.5 * pulse);
      const tw = hw * 1.05;
      g.drawImage(ringSpr[`ring_target_${st.col}`], -tw, -tw, tw * 2, tw * 2);
      g.restore();
      const mk = st.mark && hudImg[st.mark];
      if (mk) {
        // half laid onto the floor, so it reads as a mark on the ground and not as a button
        const mw = hw * 0.62, mh = mw * Math.max(0.62, ry / rx) * (mk.height / mk.width);
        g.globalAlpha = st.h * 0.92;
        g.drawImage(mk, x - mw / 2, y - mh / 2, mw, mh);
      }
    }
    if (st.hv > 0.01) {
      g.globalAlpha = st.hv * 0.55;
      g.drawImage(ringSpr[`ring_hover_${st.col}`], x - hw, y - hh, hw * 2, hh * 2);
    }
  }
  g.restore();
}

// a whole-lane spell target: a soft red wash over the lane on top of its two red rings
function drawTargets() {
  if (!selection) return;
  const hotT = hoverPos ? pickTarget(hoverPos) : null;
  for (const t of selection.targets) {
    const s = t.shape;
    if (s.kind !== 'lane') continue;
    const hot = hotT === t;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const gr = g.createLinearGradient(0, s.y0, 0, s.y1);
    gr.addColorStop(0, 'rgba(255,80,64,0)'); gr.addColorStop(0.5, `rgba(255,80,64,${hot ? 0.22 : 0.1})`); gr.addColorStop(1, 'rgba(255,80,64,0)');
    g.fillStyle = gr;
    roundRect(s.x - s.w / 2, s.y0, s.w, s.y1 - s.y0, 22); g.fill();
    g.restore();
  }
}
// a bobbing arrow over each targetable unit, drawn after the units so a Back unit never hides it
function drawTargetArrows() {
  if (!selection || !hudImg.arrow_target) return;
  const hotT = hoverPos ? pickTarget(hoverPos) : null, bob = Math.sin(gt / 170) * 7;
  for (const t of selection.targets) {
    const s = t.shape;
    if (s.kind !== 'enemy' && s.kind !== 'ally') continue;
    const aw = hotT === t ? 46 : 36, ah = (aw * hudImg.arrow_target.height) / hudImg.arrow_target.width;
    const top = s.y - CHAR_H * s.sr - 54 - ah;
    if (top >= 6) { g.drawImage(hudImg.arrow_target, s.x - aw / 2, top + bob, aw, ah); continue; }
    // no room above the enemy back row (the turn banner sits there): the arrow points at the face from the left
    g.save();
    g.translate(s.x - 52 * s.sr - ah / 2 + bob, s.y - CHAR_H * 0.8 * s.sr);
    g.rotate(-Math.PI / 2);
    g.drawImage(hudImg.arrow_target, -aw / 2, -ah / 2, aw, ah);
    g.restore();
  }
}
const inBox = (p, b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
// a Front unit's head overlaps the Back unit behind it: the target whose body centre is nearest the click wins
function pickTarget(p) {
  const hits = selection ? selection.targets.filter((t) => inBox(p, t.shape.hit)) : [];
  const body = (s) => (s.kind === 'enemy' || s.kind === 'ally' ? s.y - CHAR_H * 0.45 * s.sr : s.y);
  return hits.sort((a, b) => Math.abs(p.y - body(a.shape)) - Math.abs(p.y - body(b.shape)))[0];
}

// combat: the acting unit stands on a gold pad (its ring turns gold in drawRings)
function drawActor() {
  if (!S || S.phase !== 'combat' || S.active !== ME || busy) return;
  const f = currentActor(S);
  const v = f && views.get(f[0].uid);
  if (!v || !FX.fxTex.glowGold) return;
  const p = 0.5 + 0.5 * Math.sin(gt / 140);
  g.save();
  g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.35 + 0.25 * p;
  g.drawImage(FX.fxTex.glowGold, v.x - 100 * v.sr, v.y - 38 * v.sr, 200 * v.sr, 76 * v.sr);
  g.restore();
}

// ---------- stage, backing store and camera ----------
let K = 1;                  // backing pixels per stage px
let backdrop = null;        // the board, blurred and darkened, filling the stage behind the framed board
function sizeCanvas(stageScale) {
  const k = Math.min(2560 / STAGE_W, Math.max(0.5, stageScale * (window.devicePixelRatio || 1)));
  // compare with the real backing size: at exactly 1x (a 1080p screen in full screen) K starts equal to k
  if (Math.abs(k - K) < 0.01 && canvas.width === Math.round(STAGE_W * k)) return;
  K = k;
  canvas.width = Math.round(STAGE_W * K);
  canvas.height = Math.round(STAGE_H * K);
  backdrop = null;
}
function makeBackdrop() {
  const c = document.createElement('canvas');
  c.width = Math.round(STAGE_W / 2); c.height = Math.round(STAGE_H / 2);
  const b = c.getContext('2d');
  b.filter = 'blur(10px) brightness(0.45) saturate(1.2)';
  b.drawImage(boardImg, -40, -30, c.width + 80, c.height + 60);
  b.filter = 'none';
  const v = b.createRadialGradient(c.width / 2, c.height * 0.55, c.height * 0.3, c.width / 2, c.height * 0.55, c.width * 0.65);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.65)');
  b.fillStyle = v; b.fillRect(0, 0, c.width, c.height);
  return c;
}
// board coordinates to stage px (DOM overlays live in stage px)
const boardToStage = (x, y) => [CAM.ox + x * CAM.s, CAM.oy + y * CAM.s];

// the soft drop shadow under the framed board, blurred once at quarter size (a per-frame shadowBlur costs several ms)
let boardShadow = null;
function makeBoardShadow() {
  const c = document.createElement('canvas'), m = 120, q = 0.25;
  c.width = Math.round((W + 2 * m) * q); c.height = Math.round((H + 2 * m) * q);
  const b = c.getContext('2d');
  b.filter = `blur(${20 * q}px)`;
  b.fillStyle = 'rgba(0,0,0,0.6)'; b.fillRect(m * q, m * q, W * q, H * q);
  return c;
}

// sheets waiting for their first upload: drawn at 1 px under the backdrop, so the upload never lands mid-action
const warmQueue = [];
function draw() {
  g.setTransform(K, 0, 0, K, 0, 0);
  if (warmQueue.length) { const im = sheets[warmQueue.shift()]; if (im) g.drawImage(im, 0, 0, 1, 1); }
  if (boardImg) {
    backdrop ??= makeBackdrop();
    g.drawImage(backdrop, 0, 0, STAGE_W, STAGE_H);
  } else { g.fillStyle = '#120e0b'; g.fillRect(0, 0, STAGE_W, STAGE_H); }
  g.setTransform(K * CAM.s, 0, 0, K * CAM.s, K * (CAM.ox + cam.x), K * (CAM.oy + cam.y));
  if (boardImg) {
    boardShadow ??= makeBoardShadow();
    g.drawImage(boardShadow, -120, -120, W + 240, H + 240);
    g.drawImage(boardImg, 0, 0, W, H);
    if (decorOn) drawDecor(g);
  } else { g.fillStyle = '#222'; g.fillRect(0, 0, W, H); }
  drawRings();
  drawClosedLanes();
  hovered = hoverPos ? unitAt(hoverPos) : null;
  FX.drawAmbient(g);
  drawShrines();
  drawEffects('ground');
  FX.drawFx(g, 'ground');
  drawTargets();
  drawActor();
  for (const [uid, v] of views) if (v.removeAt && gt > v.removeAt) views.delete(uid);
  const vs = [...views.values()].sort((a, b) => a.y - b.y);
  vs.forEach(drawUnit);
  drawEffects('top');
  FX.drawFx(g, 'top');
  vs.forEach(drawHud);
  drawTargetArrows();
  drawFloats();
}

let frameCount = 0, lastFrame = 0;
function advance(now) {
  // a hidden tab gets few or no frames; a loose cap keeps the match moving at real speed there
  const dt = Math.min(1000, now - last);
  last = now;
  // hit-stop: the game clock (units, particles, waiters) holds for a beat; ambient particles keep wall time
  const gdt = FX.stopped(now) ? 0 : dt * speed;
  gt += gdt;
  FX.stepFx(gdt, dt);
  for (let i = waiters.length - 1; i >= 0; i--) if (gt >= waiters[i].at) { waiters[i].r(); waiters.splice(i, 1); }
}
function tick(now) {
  advance(now);
  frameCount++;
  FX.shakeOffset(Math.min(100, now - (lastFrame || now)), cam);
  lastFrame = now;
  draw();
  UI.positionPanel();
  updateClock(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
// when frames stop (hidden tab), the clock still runs from a timer
setInterval(() => { const now = performance.now(); if (now - last > 120) advance(now); }, 100);
window.__latent = {
  bench: (n = 120) => { const t0 = performance.now(); for (let i = 0; i < n; i++) draw(); return (performance.now() - t0) / n; },
  sel: () => selection,
  // debug: redraw the board and hand after a test changed the state by hand
  rebuild: () => { rebuildViews(); renderUI(); },
  // debug: where each legal play of a card can be dropped, as [shape kind, lane, number of choices]
  targets: (id) => targetsFor(legalNow().filter((a) => a.t === 'play' && a.id === id)).map((t) => [t.shape.kind, t.shape.lane ?? null, t.actions.length]),
  fps: () => new Promise((r) => { const f0 = frameCount, t0 = performance.now(); setTimeout(() => r(((frameCount - f0) * 1000) / (performance.now() - t0)), 1000); }), state: () => S };

// ---------- the driver: bot turns run the animation queue, human turns wait for input ----------
async function doApply(a, my) {
  busy = true;
  clearSelection();
  // apply before the render, so the played card leaves the hand and its Essence is spent at once;
  // anything else may end the turn, so the HUD keeps the old turn until the TurnStart event plays
  turnShown = a.t === 'play' ? null : { active: S.active, phase: S.phase, turn: S.turn.slice(), essence: S.players.map((p) => p.essence) };
  apply(S, a);
  renderUI();
  const events = S.events.splice(0);
  await playBatch(events, snapshot(S), my);
  if (my !== token) return;
  busy = false;
  turnShown = null;
  renderUI();
}

function humanTurn() {
  return S.active === ME && !AUTOPLAY && !(S.phase === 'combat' && autoCombat);
}

// online, the room server is the authority: your own moves go to it and come back in order with the opponent's
const remoteQ = [];
let applied = 0;   // online: actions this screen has taken from the server, the match history included
const netlog = params.has('netlog') ? (...a) => console.log('[net]', ...a) : () => {};
let remoteWake = null;
function pushRemote(item) {
  remoteQ.push(item);
  remoteWake?.();
  // the room played your turn (your time ran out): stop waiting for your move
  if (item.auto && humanResolve) { const r = humanResolve; humanResolve = null; clearSelection(); r(null); }
}

// ---------- online turn clock: the room keeps it and ends a turn that runs out (cloudflare/worker.js); this shows it ----------
let clock = null;   // { until: performance.now() ms, total }
let clockShown = '';
function setClock(left, total) {
  if (left == null) return;
  clock = { until: performance.now() + left, total: total ?? clock?.total ?? 75000 };
}
function updateClock(now) {
  const on = !!(match?.online && clock && S && S.phase !== 'over');
  const left = on ? Math.max(0, clock.until - now) : 0, mine = on && S.active === ME;
  const sec = Math.ceil(left / 1000), low = on && left <= 15000;
  const key = on ? `${sec}|${mine}|${Math.round((left / clock.total) * 400)}` : '';
  if (key === clockShown) return;
  clockShown = key;
  const pill = $('turnClock'), ring = $('clockRing');
  pill.classList.toggle('hidden', !on);
  ring.classList.toggle('hidden', !mine);
  if (!on) return;
  pill.textContent = `${sec}`;
  pill.classList.toggle('low', low);
  ring.classList.toggle('low', low);
  ring.querySelector('.arc').style.strokeDashoffset = `${100 - (100 * left) / clock.total}`;
}
async function nextRemote(my) {
  while (!remoteQ.length) {
    await new Promise((r) => (remoteWake = r));
    remoteWake = null;
    if (my !== token) return null;
  }
  return remoteQ.shift();
}

async function driver(my) {
  while (my === token && S.phase !== 'over') {
    let a;
    if (match.online) {
      if (S.active === ME && !remoteQ.length) {
        let mine;
        if (humanTurn()) {
          renderUI();
          mine = await new Promise((r) => (humanResolve = r));
          humanResolve = null;
          if (my !== token) return;
        } else mine = BOTS.greedy(S);   // auto combat
        // null: your time ran out and the room is playing the turn for you, its moves are already queued
        if (mine) {
          busy = true;
          renderUI();
          netlog('send', S.turn, S.active, mine.t, net?.state.history.length);
          match.online.sendAction(mine);
        }
      }
      const item = await nextRemote(my);
      if (my !== token || !item) return;
      a = item.a;
      reveal(S, item.r);   // the cards this action draws, as far as this seat may see them
      applied++;
    } else if (match.hotseat && (S.active !== ME || match.coverFor !== S.active)) {
      await handoff(my);
      continue;
    } else if (humanTurn()) {
      renderUI();
      a = await new Promise((r) => (humanResolve = r));
      humanResolve = null;
      if (my !== token) return;
    } else {
      await wait(S.active !== ME ? 300 : 150);
      if (my !== token) return;
      // the other seat is the chosen bot; your own seat only gets here on auto combat or autoplay
      a = S.active !== ME ? match.opponent(S) : BOTS.greedy(S);
    }
    await doApply(a, my);
  }
  renderUI();
}

// ---------- hotseat: two players, one screen ----------
// Before each turn a cover hides the board and both hands while the device changes hands. Behind it the board turns
// to the new player's side (units, Shrines and the hand), so the first thing they see after READY is their own turn.
let coverResolve = null;
function turnTo(p) {
  ME = p;
  clearSelection();
  floats = []; effects = []; ringState.clear();
  rebuildViews();
  shrineHp = [ME, 1 - ME].map((q) => S.players[q].shrines.slice());
  shrineFlash = [[0, 0, 0], [0, 0, 0]];
  hud = snapshot(S);
  $('enemyName').textContent = who(1 - ME);
  UI.resync();
  renderUI();
}
function showCover(p) {
  $('coverWho').src = uiArt(`lbl_player_${p + 1}`);
  $('coverWho').alt = `PLAYER ${p + 1}`;
  $('cover').classList.remove('hidden');
}
function hideCover() { $('cover').classList.add('hidden'); coverResolve = null; }
async function handoff(my) {
  const p = S.active;
  busy = true;
  showCover(p);
  turnTo(p);
  match.coverFor = p;
  if (AUTOPLAY) await wait(400);
  else await new Promise((r) => (coverResolve = r));
  if (my !== token) return;
  hideCover();
  // two players on their first match ever: the board tour once, after the first READY
  if (!match.toured && guide.needsTour() && !AUTOPLAY) { match.toured = true; await guide.tour(); if (my !== token) return; }
  UI.banner('your');
  busy = false;
  renderUI();
}
$('coverReady').onclick = () => coverResolve?.();
$('coverBack').onclick = () => { hideCover(); UI.reset(); clearSelection(); UI_back(); };

// a match: the seat this screen plays (me), both decks by engine seat, the seed and the bot for the other seat.
// PLAY AGAIN replays the same setup with a new seed
let match = null;
function botMatch({ me = 0, level = 'normal', deck = DECK, botDeck = null, seed = null } = {}) {
  const foe = botDeck ?? Object.values(STARTERS)[Math.floor(Math.random() * Object.keys(STARTERS).length)].cards;
  const decks = me === 0 ? [deck, foe] : [foe, deck];
  return { me, decks, seed, level, opponent: BOT_LEVELS[level] ?? BOT_LEVELS.normal };
}

// a match picked up part way (an online resume, the ?ff= debug skip) has units with no Summon event behind them:
// they are simply drawn where they stand
function rebuildViews() {
  views = new Map();
  for (let lane = 0; lane < 3; lane++)
    for (const p of [0, 1])
      for (let slot = 0; slot < 2; slot++) {
        const u = S.board[lane][p][slot];
        if (!u) continue;
        const v = makeView({ uid: u.uid, id: u.id, p, lane, slot }, u);
        Object.assign(v, { born: gt - 5000, alpha: 1, taunt: u.taunt, frozen: u.frozen, burn: u.burn });
        views.set(u.uid, v);
      }
  shrineDown = [ME, 1 - ME].map((p) => S.players[p].shrines.map((h) => h <= 0));
  S.closed.forEach((c, lane) => { closedAt[lane] = c ? gt - 5000 : null; });
}

const LEVEL_NAME = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
function startMatch(setup = match ?? botMatch()) {
  match = setup;
  $('menu').classList.add('hidden');
  if (setup.training) setup.training = { units: 0, spells: 0 };
  // two players: the cover is up from the start, so the opening hand is dealt out of sight
  if (setup.hotseat) { setup.coverFor = -1; showCover(0); } else hideCover();
  guide.coach(null);
  setAmbientPaused(false);
  ME = setup.me;
  $('enemyName').textContent = setup.foeName ?? `Computer, ${LEVEL_NAME[setup.level] ?? 'Normal'}`;
  const my = ++token;
  // the old match's pending waits never resolve, so its async chain stops instead of touching the new board
  waiters.length = 0;
  humanResolve = null;
  remoteQ.length = 0;
  remoteWake?.();
  UI.reset();
  views = new Map(); floats = []; effects = []; banner = null; selection = null; turnShown = null;
  $('matchLoad').classList.add('hidden');
  $('matchMsg').hidden = $('matchRetry').hidden = true;
  const want = sheetsForMatch(setup.decks, !!setup.hotseat);
  FX.clearFx();   // particles and lit rings from the last match must not carry over
  ringState.clear();
  shrineDown = [[false, false, false], [false, false, false]]; shrineFlash = [[0, 0, 0], [0, 0, 0]];
  closedAt = [null, null, null];
  const seed = setup.seed ?? (+params.get('seed') || 1 + Math.floor(Math.random() * 99999));
  // online, the room deals: the decks come in their dealt order with every card this seat may not see hidden
  // (engine/hidden.js), and each action brings the cards it draws
  S = setup.deal
    ? newGame(db, setup.deal.map((d) => d.slice()), 0, { ...(setup.cfg ?? {}), log: true, dealt: true, lanes: setup.lanes })
    : newGame(db, setup.decks.map((d) => d.slice()), seed, { ...(setup.cfg ?? {}), log: true });
  // history first (a resumed online match), then the debug skip: both silently, then draw the board as it stands
  const history = setup.actions ?? [], skip = setup.ff ?? 0;
  applied = history.length;
  for (const h of history) { reveal(S, h.r); apply(S, h.a); }
  for (let i = 0; i < skip && S.phase !== 'over'; i++) apply(S, BOTS.greedy(S));
  const resumed = history.length > 0 || skip > 0;
  if (resumed) { S.events.length = 0; rebuildViews(); }
  hud = snapshot(S);
  shrineHp = [ME, 1 - ME].map((p) => hud.shrines[p].slice());
  busy = true;
  (async () => {
    await untilLoaded(want, my);
    if (my !== token) return;
    await playBatch(S.events.splice(0), snapshot(S), my);
    if (my !== token) return;
    // the first match ever (not an online one, where the clock runs) starts with the board tour
    if (!setup.online && !setup.hotseat && !resumed && guide.needsTour() && !AUTOPLAY) { await guide.tour(); if (my !== token) return; }
    busy = false;
    if (resumed) renderUI();
    if (resumed && S.phase === 'over') showOver(S.winner, S.endReason);
    driver(my);
  })();
}

// ---------- online rooms: net.js talks to server/rooms.mjs, loaded only when a room is opened ----------
const NAMES = ['Ember', 'Frost', 'Rune', 'Spark', 'Cinder', 'Rime', 'Ash', 'Glacier'];
const myName = (() => {
  try { const n = sessionStorage.getItem('latent.name'); if (n) return n; } catch {}
  const n = `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${100 + Math.floor(Math.random() * 900)}`;
  try { sessionStorage.setItem('latent.name', n); } catch {}
  return n;
})();
let net = null, host = false;
async function getNet() {
  if (net) return net;
  const { createNet } = await import('./net.js');
  net = createNet();
  net.on('room', (m) => {
    const foe = m.players.length > 1 ? m.players[host ? 1 : 0] : null;
    MENU.room({ code: m.code, opponent: foe?.name ?? null });
  });
  net.on('start', (m) => {
    netlog('start', m.seat, m.actions?.length);
    MENU.leaveForMatch();
    initAudio();
    startMatch({ me: m.seat, decks: m.decks, deal: m.deal, lanes: m.lanes, cfg: m.cfg, actions: m.actions, online: net, foeName: m.names?.[1 - m.seat] ?? 'Opponent' });
    clock = null;
    setClock(m.left, m.turnMs);
  });
  let autoRun = false;
  net.on('action', (m) => {
    netlog('action', m.n, m.seat, m.a.t, !!match?.online, m.auto ? 'auto' : '');
    if (!match?.online) return;
    setClock(m.left);
    // the first move the room plays for a player whose time ran out says so once
    if (m.auto && !autoRun) log(m.seat === ME ? 'Time is up. Your turn ended.' : 'Your opponent ran out of time.', 'turn', { icon: 'turn' });
    autoRun = !!m.auto;
    pushRemote({ a: m.a, r: m.r, auto: !!m.auto && m.seat === ME });
  });
  // a refused move means this screen and the server disagree: take the whole match again from the server
  net.on('reject', (m) => { netlog('reject', m.reason, m.n); if (match?.online && S?.phase !== 'over') net.resume(); });
  net.on('opponent_left', (m) => { if (match?.online && S?.phase !== 'over' && m.graceMs) log(`Your opponent dropped. They have ${Math.round(m.graceMs / 1000)} s to come back.`, 'turn', { icon: 'turn' }); });
  net.on('opponent_back', () => { if (match?.online) log('Your opponent is back.', 'turn', { icon: 'turn' }); });
  net.on('over', (m) => {
    // the engine shows its own ends (Shrines, turn limit); a forfeit or a leave never reaches the engine
    if (!match?.online || !['forfeit', 'left', 'timeout'].includes(m.reason)) return;
    ++token;
    const why = m.reason !== 'timeout' ? 'Your opponent left the match.'
      : m.winner === ME ? 'Your opponent ran out of time three turns in a row.' : 'You ran out of time three turns in a row.';
    UI.over(m.winner === 'draw' || m.winner == null ? 'draw' : V(m.winner), why);
  });
  net.on('error', (m) => { if (!match?.online || S?.phase === 'over') MENU.roomFailed(roomError(m.reason)); });
  return net;
}
function roomError(r = '') {
  if (r === 'unknown room') return 'No room with that code.';
  if (r === 'room full') return 'That room is full.';
  if (r === 'room expired') return 'The room closed.';
  if (r === 'connection lost') return 'Lost the link to the room.';
  if (r === 'busy') return 'Online play is full for today. Try again tomorrow.';
  if (r.startsWith('bad deck')) return 'Your deck is not legal.';
  return 'The room server said no. Try again.';
}
const online = {
  name: myName,
  async create(deck) { host = true; (await getNet()).createRoom(deck, myName); },
  async join(code, deck) { host = false; (await getNet()).joinRoom(code, deck, myName); },
  cancel() { net?.leave(); },
};
// watchdog: the server has moves this screen never queued (a lost message): take the match again
setInterval(() => {
  if (!match?.online || !remoteWake || S?.phase === 'over' || match.online.state.status !== 'open') return;
  if (match.online.state.history.length > applied + remoteQ.length) { netlog('resync', applied, match.online.state.history.length); match.online.resume(); }
}, 3000);
// a reload in the middle of an online match takes the seat back
try { if (ONLINE && sessionStorage.getItem('latent.room')) getNet().then((n) => n.state.token && n.resume()); } catch {}

// ---------- UI glue: ui.js draws the hand, the HUD and the screens; these are the hooks it calls ----------
function legalNow() { return S && humanTurn() && !busy ? legalActions(S) : []; }
function renderUI() { UI.render(); coachTick(); }

// ---------- first run help: the board tour before the first match, the coach in the training match (guide.js) ----------
// a row of Shrines (side 1: the enemy's at the top, 0: yours) as a box in stage px; they are canvas art, not DOM
function shrineBox(side) {
  const pts = SHRINE[side].map(([x, y]) => toCss(x, y));
  const x0 = Math.min(...pts.map((p) => p[0])) - 100, x1 = Math.max(...pts.map((p) => p[0])) + 100, y0 = Math.min(...pts.map((p) => p[1]));
  return { x: x0, y: y0 - (side ? 40 : 110), w: x1 - x0, h: 190 };
}
const guide = createGuide({ shrines: () => shrineBox(1) });
const TRAIN_TURNS = 3;   // the coach helps through your first three turns, then lets you finish the match
const domRect = (id) => () => guide.rect($(id));
function coachTick() {
  const t = match?.training;
  if (!t || !S || S.phase === 'over') return guide.coach(null);
  if (S.turn[ME] > TRAIN_TURNS || (S.turn[ME] === TRAIN_TURNS && S.active !== ME)) {
    if (!t.byeAt) t.byeAt = performance.now();
    return guide.coach(performance.now() - t.byeAt < 5000 ? { at: domRect('turnPill'), side: 'below', text: 'That is all you need. Win the match!' } : null);
  }
  if (selection) return guide.coach(null);   // a card is in hand: let the player aim
  if (S.active !== ME) return guide.coach(S.phase === 'combat'
    ? { at: () => shrineBox(0), side: 'above', text: 'The enemy units attack now. A unit with nobody in front of it hits your Shrine.' }
    : { at: domRect('enemyPanel'), side: 'below', text: 'The enemy plays its cards now. Watch the board.' });
  if (S.phase === 'combat') return guide.coach(!$('actPanel').classList.contains('hidden')
    ? { at: domRect('actPanel'), side: 'above', text: 'Your units act one by one. Attack hits the enemy in front, Skill is the unit\'s special move.' } : null);
  if (busy) return;
  const legal = legalActions(S), card = (type) => legal.some((a) => a.t === 'play' && db[a.id]?.type === type);
  if (card('unit') && t.units === 0) return guide.coach({ at: handRect, side: 'above', text: 'Drag a unit card onto a glowing ring on your side of the board.' });
  if (card('spell') && t.spells === 0 && S.turn[ME] >= 2) return guide.coach({ at: handRect, side: 'above', text: 'Spells work at once. Drag a spell onto a glowing target.' });
  if (card('unit') && t.units < 2 && S.turn[ME] >= 2) return guide.coach({ at: handRect, side: 'above', text: 'You have Essence left. Play another unit in an empty lane.' });
  return guide.coach({ at: domRect('endBtn'), side: 'left', text: 'Tap here to end your turn. Then your units fight.' });
}

function clearSelection() {
  selection = null;
  $('chooser').classList.add('hidden');
}

// a card from the hand: untargeted cards fly in at once, the rest light up their targets on the board.
// keep: the card is being dragged, so only light the targets up
function selectCard(id, index, { keep = false } = {}) {
  if (!humanTurn() || busy) return;
  if (!keep && selection?.kind === 'card' && selection.index === index) { clearSelection(); renderUI(); return; }
  const acts = legalNow().filter((a) => a.t === 'play' && a.id === id);
  if (!acts.length) return;
  if (!keep && acts.length === 1 && (acts[0].lane == null || db[id].type === 'joker') && !acts[0].target) { UI.commitCard(acts[0], null); return; }
  selection = { kind: 'card', id, index, targets: targetsFor(acts) };
  renderUI();
}

function choose(a) {
  clearSelection();
  if (match?.training && a?.t === 'play') { const ty = db[a.id]?.type; if (ty === 'unit') match.training.units++; else if (ty === 'spell') match.training.spells++; }
  if (humanResolve) humanResolve(a);
}

// board coordinates to the stage px that DOM overlays use
function toCss(x, y) { return boardToStage(x, y); }

// ---------- canvas input ----------
function boardPos(e) {
  const r = canvas.getBoundingClientRect();
  const sx = ((e.clientX - r.left) * STAGE_W) / r.width, sy = ((e.clientY - r.top) * STAGE_H) / r.height;
  return { x: (sx - CAM.ox) / CAM.s, y: (sy - CAM.oy) / CAM.s };
}
function unitAt(p) {
  const vs = [...views.values()].filter((v) => !v.dying).sort((a, b) => b.y - a.y);
  return vs.find((v) => inBox(p, { x0: v.x - 50 * v.sr, x1: v.x + 50 * v.sr, y0: v.y - CHAR_H * v.sr - 10, y1: v.y + 20 * v.sr }));
}

canvas.addEventListener('click', (e) => {
  if (!S || busy || !humanTurn() || UI.isBusy()) return;
  const p = boardPos(e);
  if (selection) {
    const t = pickTarget(p);
    if (!t) { clearSelection(); renderUI(); return; }
    // several actions on one target (Mirror: which element) open a chooser; a card flies to its target first
    if (t.actions.length > 1) { UI.openChooser(t); return; }
    if (selection.kind === 'card') UI.commitCard(t.actions[0], t.shape);
    else choose(t.actions[0]);
    return;
  }
  if (S.phase !== 'main') return;
  const v = unitAt(p);
  if (v && v.side === 0) {
    const f = findUnit(S, v.uid);
    const moves = legalNow().filter((a) => a.t === 'move' && f && a.lane === f[1] && a.slot === f[3]);
    if (moves.length) { selection = { kind: 'move', from: v.uid, targets: targetsFor(moves) }; renderUI(); }
  }
});
canvas.addEventListener('contextmenu', (e) => { if (selection) { e.preventDefault(); clearSelection(); renderUI(); } });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selection) { clearSelection(); renderUI(); } });

// hover: highlight targets and show the unit's own card as a tooltip
canvas.addEventListener('mousemove', (e) => {
  hoverPos = boardPos(e);
  const overTarget = !!pickTarget(hoverPos);
  const v = unitAt(hoverPos);
  canvas.classList.toggle('pointer', !!overTarget || (!!v && v.side === 0 && !busy && humanTurn() && S?.phase === 'main'));
  const f = v && S && findUnit(S, v.uid);
  UI.unitTip(f ? v : null, f);
});
canvas.addEventListener('mouseleave', () => { hoverPos = null; UI.unitTip(null); });

// ---------- controls ----------
$('endBtn').onclick = () => { if (humanTurn() && !busy && S.phase === 'main') choose({ t: 'end' }); };
const SPEEDS = [1, 2, 4];
function setSpeed(v) {
  speed = v;
  settings.speed = v; saveSettings();
  document.querySelectorAll('.speed').forEach((x) => x.classList.toggle('on', +x.dataset.speed === speed));
  $('speedLabel').innerHTML = numImg(`${speed}x`);
  document.documentElement.style.setProperty('--spd', speed);
}
document.querySelectorAll('.speed').forEach((b) => { b.onclick = () => setSpeed(+b.dataset.speed); });
$('speedBtn').onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]);
setSpeed(speed);
$('autoCombat').checked = autoCombat;
$('autoCombat').onchange = () => {
  autoCombat = $('autoCombat').checked;
  settings.autoCombat = autoCombat; saveSettings();
  // switching it on while you are choosing hands this unit to the bot
  if (autoCombat && humanResolve && S.phase === 'combat') choose(BOTS.greedy(S));
  else renderUI();
};
function setSound(on) {
  soundOn = on; settings.sound = on; saveSettings();
  $('soundBtn').classList.toggle('off', !on);
  $('soundOpt').checked = on;
}
$('soundBtn').classList.toggle('off', !soundOn);
$('soundOpt').checked = soundOn;
$('soundBtn').onclick = () => setSound(!soundOn);
$('soundOpt').onchange = () => setSound($('soundOpt').checked);
$('shakeOpt').checked = shakeOn;
$('shakeOpt').onchange = () => { shakeOn = $('shakeOpt').checked; settings.shake = shakeOn; saveSettings(); };
// the same panel opens from the title as SETTINGS, without the match buttons
$('titleGear').onclick = () => { $('menu').classList.add('settings'); $('menu').classList.remove('hidden'); };
$('menuBtn').onclick = () => { $('menu').classList.remove('settings'); $('menu').classList.toggle('hidden'); };
$('closeMenu').onclick = () => $('menu').classList.add('hidden');
$('restartBtn').onclick = () => { $('menu').classList.add('hidden'); if (!S || match?.online) return; startMatch(); };
// leaving an online match loses it (the server tells the opponent); against the computer it just ends
$('leaveBtn').onclick = () => { $('menu').classList.add('hidden'); UI.reset(); clearSelection(); UI_back(); };
$('menuBtn').addEventListener('click', () => { $('restartBtn').classList.toggle('hidden', !!match?.online); });

const UI = createUI({
  db, ecol, SKILL_NAME, currentActor, wait, toCss, legalNow, choose, selectCard, targetsFor, pickTarget,
  S: () => S, me: () => ME, views: () => views, speed: () => speed, busy: () => busy, shown: () => turnShown,
  humanTurn: () => !!S && humanTurn(),
  hasArt: (id) => !!portraits[id],
  getSel: () => selection, setSel: (s) => { selection = s; }, clearSel: clearSelection,
  setHover: (p) => { hoverPos = p; },
  boardPos: (clientX, clientY) => boardPos({ clientX, clientY }),
  // online, PLAY AGAIN asks the room for a rematch (seats swap); the new match arrives as a 'start'
  restart: () => {
    if (!match?.online) { startMatch(); return; }
    match.online.rematch();
    $('againBtn').disabled = true;
    $('overReason').textContent = 'Rematch asked. Waiting for your opponent.';
  },
  back: () => UI_back(),
});
function UI_back() {
  setAmbientPaused(true);
  if (match?.online) { match.online.leave(); match = null; }
  ++token; waiters.length = 0; humanResolve = null; remoteWake?.();
  $('over').classList.add('hidden');
  $('matchLoad').classList.add('hidden');
  hideCover();
  MENU.openSetup();
}
const MENU = createMenu({
  db, cardEl: UI.cardEl, numImg, onAudio: () => initAudio(), online: ONLINE ? online : null,
  // the card book's pedestal: a character's clip seen from the front, a spell's effect, and their sounds
  clipOf: (id, action) => {
    const n = `${keyOf(id)}_front_${action}`;
    return meta[n] ? { url: `assets/${LITE ? 'sprites_half' : 'sprites'}/${n}.webp`, m: meta[n], sound: n } : null;
  },
  vfxOf: (id) => (vfxMeta[id] && vfxFiles.has(`${id}.webp`) ? { url: `assets/vfx/${id}.webp`, m: vfxMeta[id], sound: vfxMeta[id].sfx } : null),
  sound: (name) => { if (name) { initAudio(); sfx(name); } },
  // training: an easy bot, a fixed seed and the balanced deck on both sides, so the first turns teach the basics
  onPlay: ({ mode, level, deck, decks }) => mode === 'training'
    ? startMatch({ ...botMatch({ me: 0, level: 'easy', deck: STARTERS.balanced.cards, botDeck: STARTERS.balanced.cards, seed: 2027 }), training: {} })
    : mode === 'hotseat' ? startMatch(hotseatMatch(decks))
    : startMatch(botMatch({ me: 0, level, deck, botDeck: STARTERS[params.get('bot')]?.cards ?? takeBot() })),
  onPrepare: prepareDecks,
});
window.__latent.cardEl = UI.cardEl;
window.__latent.net = () => ({ ME, busy, token, queued: remoteQ.length, waiting: !!remoteWake, human: !!humanResolve, seat: net?.state.seat, hist: net?.state.history.length, status: net?.state.status, online: !!match?.online });
window.__latent.over = UI.over;   // debug: show the game over screen with the current match

// the 1920x1080 stage is scaled to fit the window; the canvas backing store follows the real pixel size
// The stage's size and edges land on whole device pixels: at a fractional scale the edge row is part stage, part
// letterbox, and the moving layers under the stage's clip (the title key art, the board) bled through it as a
// flickering 1 px line along the top and bottom. 1920 and 1080 are 16 and 9 times 120, so a scale in steps of
// 1/(120 dpr) makes both sides whole; the letterbox grows by at most 16 device px.
function fit() {
  const dpr = window.devicePixelRatio || 1;
  const s = Math.max(1, Math.floor(Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H) * dpr * 120)) / (dpr * 120);
  const x = Math.round(((innerWidth - STAGE_W * s) / 2) * dpr) / dpr, y = Math.round(((innerHeight - STAGE_H * s) / 2) * dpr) / dpr;
  $('stage').style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  sizeCanvas(s);
}
window.addEventListener('resize', fit);
// moving the window to a screen with another pixel ratio does not always send a resize
(function watchDpr() { matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => { fit(); watchDpr(); }, { once: true }); })();
fit();
$('phase').textContent = 'Ready';
// debug and test: ?seat=1&level=hard&deck=ember_rush&bot=frost_bastion start a bot match at once (with ?autoplay=1, or ?mode=bot)
// hotseat: both seats human; the greedy bot only plays a seat on auto combat or ?autoplay=1
function hotseatMatch(decks) { return { me: 0, decks: decks.map((d) => d.slice()), seed: null, hotseat: true, opponent: BOTS.greedy, foeName: 'Player 2' }; }
// ?mode=hotseat&deck=..&bot=.. starts two players at once (the second deck from bot=)
function urlMatch() {
  const deck = STARTERS[params.get('deck')]?.cards, botDeck = STARTERS[params.get('bot')]?.cards;
  if (params.get('mode') === 'hotseat') return { ...hotseatMatch([deck ?? DECK, botDeck ?? DECK]), ff: +params.get('ff') || 0 };
  return { ...botMatch({ me: params.get('seat') === '1' ? 1 : 0, level: params.get('level') || 'normal', deck, botDeck }), ff: +params.get('ff') || 0 };
}
if (params.get('screen')) MENU.open(params.get('screen'));
else if (ONLINE && params.get('join')) MENU.joinLink(params.get('join'));
else if (AUTOPLAY || params.get('mode') === 'bot' || params.get('mode') === 'hotseat') { for (const id of ['start', 'menuBg']) $(id).classList.add('hidden'); startMatch(urlMatch()); }
// everything the first screen needs is in: the loading screen lifts (boot.js)
window.__boot?.done();
// on the title the decks from the last setup start loading in the background, so PLAY rarely has to wait
if (!$('start').classList.contains('hidden')) MENU.prepare();
