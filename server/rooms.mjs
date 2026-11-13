// Latent Legends room server: online matches for two players, zero dependencies (node:http + node:crypto).
// One process serves the game's static files (web/, engine/, sim/, data/) and a hand-rolled RFC 6455
// WebSocket on /ws. The server keeps the engine state of every room and only accepts legal actions
// from the acting seat; clients replay the broadcast actions in order, each from what its seat may see
// (engine/hidden.js). Protocol: server/PROTOCOL.md.
// node server/rooms.mjs   (PORT, HOST, GRACE_MS, IDLE_MS env vars; defaults 8787, 127.0.0.1, 60000, 600000)
// It listens on this machine only. HOST=0.0.0.0 lets other devices on the network open the game and join.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync, createReadStream, promises as fsp } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { indexCards, legalActions } from '../engine/rules.js';
import { validateDeck } from '../engine/deck.js';
import { deal, play, seen, dealtFor, listOf } from '../engine/hidden.js';
import { actionShape, cleanName, sameToken, pingT, ipKey } from './guard.mjs';
import { securityHeaders } from './headers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PUBLIC = new Set(['web', 'engine', 'sim', 'data']);
const db = indexCards(JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url))).cards);

export const DEFAULTS = {
  port: 8787, host: '127.0.0.1',   // this machine only; '0.0.0.0' (or '::') for every network interface
  graceMs: 60_000,          // a dropped player gets this long to resume before the opponent wins by forfeit
  idleMs: 600_000,          // a room with no traffic for this long is closed
  sweepMs: 30_000, heartbeatMs: 20_000,
  maxMsg: 16 * 1024,        // bytes per WebSocket message (also per fragmented message)
  rate: { burst: 120, perSec: 60 },  // token bucket per connection, generous: auto combat can send a burst
  maxRooms: 5000, maxClients: 5000,
  perIp: 32,                // open sockets per address (an IPv6 /64 counts as one)
  roomsPerMin: 10,          // rooms one address may create a minute
  failedJoins: 20,          // joins to a missing or full room, and resumes of no seat, one address may make in 10 minutes
  waitMs: 60_000,           // a room nobody is connected to and no match runs in is closed after this long
  frames: { burst: 400, perSec: 200 },   // WebSocket frames per connection, control and continuation frames too
  // pages that may open sockets, besides this server's own pages and pages on this machine or the local network
  origins: [],
  engine: {},               // engine options for every match (newGame opts)
  listing: true,            // directory listings, play.js discovers its optional assets through them
  log: true,
};

// ---------- WebSocket (RFC 6455, server side) ----------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const okCode = (c) => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);

class WS {
  constructor(socket, maxMsg) {
    this.socket = socket; this.max = maxMsg;
    this.buf = Buffer.alloc(0); this.frag = null; this.fragLen = 0;
    this.ftokens = 0; this.fat = Date.now(); this.frames = null;
    this.closeSent = false; this.dead = false; this.done = false; this.alive = true;
    this.onmessage = null; this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.feed(d));
    // the other side closed its half without a close frame: the socket is done, and so is its place in the counts
    socket.on('end', () => this.terminate());
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => socket.destroy());
  }
  get open() { return !this.dead && !this.closeSent && this.socket.writable; }

  feed(d) {
    if (this.dead) return;   // a failed socket's remaining bytes are dropped, not buffered
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.dead) {
      const used = this.frame();
      if (!used) break;
      this.buf = this.buf.subarray(used);
    }
  }

  // parse one frame from the buffer; returns the bytes it used, 0 when incomplete (or failed)
  frame() {
    const b = this.buf;
    if (b.length < 2) return 0;
    const fin = b[0] & 0x80, op = b[0] & 0x0f;
    let len = b[1] & 0x7f, off = 2;
    if (b[0] & 0x70) return this.fail(1002, 'reserved bits');
    if (!(b[1] & 0x80)) return this.fail(1002, 'unmasked frame');
    if (op >= 8 && (!fin || len > 125)) return this.fail(1002, 'bad control frame');
    if (len === 126) { if (b.length < 4) return 0; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return 0;
      if (b.readUInt32BE(2)) return this.fail(1009, 'too big');
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > this.max || (op === 0 && this.fragLen + len > this.max)) return this.fail(1009, 'too big');
    if (b.length < off + 4 + len) return 0;
    // every frame counts, so a flood of empty or control frames is cut off like a flood of messages
    if (this.frames) {
      const now = Date.now(), f = this.frames;
      this.ftokens = Math.min(f.burst, this.ftokens + ((now - this.fat) / 1000) * f.perSec);
      this.fat = now;
      if (this.ftokens < 1) return this.fail(1008, 'too many frames');
      this.ftokens--;
    }
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    this.handle(fin, op, data);
    return off + 4 + len;
  }

  handle(fin, op, data) {
    if (op === 0x8) {
      let code = 1005;
      if (data.length === 1) return this.fail(1002, 'bad close');
      if (data.length >= 2) {
        code = data.readUInt16BE(0);
        if (!okCode(code)) return this.fail(1002, 'bad close code');
        try { UTF8.decode(data.subarray(2)); } catch { return this.fail(1007, 'bad utf-8'); }
      }
      if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : code);
      this.dead = true;
      this.socket.end();
      return this.finish(code);
    }
    if (op === 0x9) return this.raw(0xa, data);
    if (op === 0xa) return;
    if (op === 0x2) return this.fail(1003, 'text only');
    if (op === 0x1) {
      if (this.frag) return this.fail(1002, 'expected continuation');
      if (fin) return this.text(data);
      this.frag = [data]; this.fragLen = data.length;
      return;
    }
    if (op === 0x0) {
      if (!this.frag) return this.fail(1002, 'unexpected continuation');
      if (this.frag.length >= 64) return this.fail(1009, 'too many fragments');
      this.frag.push(data); this.fragLen += data.length;
      if (!fin) return;
      const whole = Buffer.concat(this.frag);
      this.frag = null; this.fragLen = 0;
      return this.text(whole);
    }
    return this.fail(1002, 'bad opcode');
  }

  text(buf) {
    let s;
    try { s = UTF8.decode(buf); } catch { return this.fail(1007, 'bad utf-8'); }
    if (this.onmessage && !this.closeSent) this.onmessage(s);
  }

  raw(op, data) {
    if (this.dead || !this.socket.writable) return false;
    // a client that stops reading gets cut off instead of growing our memory (pongs included)
    if (this.socket.writableLength > 1 << 20) { this.terminate(); return false; }
    const len = data.length, head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = len;
    else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
    this.socket.write(Buffer.concat([head, data]));
    return true;
  }

  send(str) {
    if (!this.open) return false;
    return this.raw(0x1, Buffer.from(str));
  }

  sendClose(code, reason = '') {
    this.closeSent = true;
    const r = Buffer.from(reason).subarray(0, 120), b = Buffer.alloc(2 + r.length);
    b.writeUInt16BE(code, 0); r.copy(b, 2);
    this.raw(0x8, b);
  }

  // polite close: wait for the client's close frame, then drop the socket anyway after 2 s
  close(code = 1000, reason = '') {
    if (this.closeSent || this.dead) return;
    this.sendClose(code, reason);
    setTimeout(() => this.terminate(), 2000).unref();
  }

  fail(code, reason) {
    if (!this.closeSent) this.sendClose(code, reason);
    this.dead = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.finish(code);
    return 0;
  }

  terminate() { this.dead = true; this.socket.destroy(); this.finish(1006); }

  finish(code) {
    if (this.done) return;
    this.done = true;
    this.onclose?.(code);
  }
}

function upgrade(req, socket, head, maxMsg) {
  const key = req.headers['sec-websocket-key'];
  const ok = req.method === 'GET' && /\bwebsocket\b/i.test(req.headers.upgrade || '') &&
    /\bupgrade\b/i.test(req.headers.connection || '') && req.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new WS(socket, maxMsg);
  if (head?.length) ws.feed(head);
  return ws;
}

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function plain(res, status, body = '', headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req, res, opts) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
  const rawPath = req.url.split('?')[0].split('#')[0];
  if (rawPath === '/' || rawPath === '') { res.writeHead(302, { Location: '/web/play.html', 'Content-Length': 0 }); return res.end(); }
  let path;
  try { path = decodeURIComponent(rawPath); } catch { return plain(res, 400, 'Bad path\n'); }
  const parts = path.split('/').filter(Boolean);
  // no traversal, no dotfiles, no backslashes or NULs, and only the four public folders
  if (/%2e|%2f|%5c/i.test(rawPath) || parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0')) || !PUBLIC.has(parts[0]))
    return plain(res, 404, 'Not found\n');
  const top = resolve(ROOT, parts[0]), file = resolve(ROOT, ...parts);
  if (file !== top && !file.startsWith(top + sep)) return plain(res, 404, 'Not found\n');
  let st, real;
  try { [st, real] = await Promise.all([fsp.stat(file), fsp.realpath(file)]); } catch { return plain(res, 404, 'Not found\n'); }
  const realTop = await fsp.realpath(top);
  if (real !== realTop && !real.startsWith(realTop + sep)) return plain(res, 404, 'Not found\n');

  if (st.isDirectory()) {
    // one leading slash, so //web/ can not turn into a link to a host named web
    if (!rawPath.endsWith('/')) { res.writeHead(301, { Location: `/${rawPath.replace(/^\/+/, '')}/`, 'Content-Length': 0 }); return res.end(); }
    try { const idx = resolve(file, 'index.html'); const s2 = await fsp.stat(idx); if (s2.isFile()) return sendFile(req, res, idx, s2); } catch {}
    if (!opts.listing) return plain(res, 404, 'Not found\n');
    // same shape as python's http.server listing: <a href="name/"> for folders, <a href="name"> for files
    const ents = (await fsp.readdir(file, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).sort((a, b) => (a.name < b.name ? -1 : 1));
    const items = ents.map((e) => { const n = e.name + (e.isDirectory() ? '/' : ''); return `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${esc(n)}</a></li>`; });
    const body = `<!DOCTYPE HTML>\n<html lang="en">\n<head><meta charset="utf-8"><title>Directory listing for ${esc(path)}</title></head>\n<body>\n<h1>Directory listing for ${esc(path)}</h1>\n<hr>\n<ul>\n${items.join('\n')}\n</ul>\n<hr>\n</body>\n</html>\n`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (!st.isFile()) return plain(res, 404, 'Not found\n');
  return sendFile(req, res, file, st);
}

function sendFile(req, res, file, st) {
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': st.mtime.toUTCString(),
    'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = +range[1]; if (range[2]) end = Math.min(+range[2], end); }
    else start = Math.max(0, st.size - +range[2]);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !st.size) return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

// ---------- rooms ----------

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1
const CODE_RE = new RegExp(`^[${ALPHABET}]{5}$`);
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.+\.local)$/;
// stable JSON (sorted keys), used to compare actions and to hash states
export const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
export const stateHash = (s) => createHash('sha1').update(stable({ players: s.players, board: s.board, phase: s.phase, active: s.active, winner: s.winner })).digest('hex');
// a page may open sockets when this server served it, when it is on this machine or the local network, or when it is
// listed in opts.origins; a client without an Origin is not a browser page
function originOk(req, opts) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  return u.host === req.headers.host || LOCAL_HOST.test(u.hostname) || opts.origins.includes(origin);
}

export function startServer(options = {}) {
  const opts = { ...DEFAULTS, ...options, rate: { ...DEFAULTS.rate, ...options.rate } };
  const rooms = new Map();
  const clients = new Set();
  const perIp = new Map();      // address key -> open sockets
  const recent = new Map();     // address key -> { at, rooms, fails }: rooms made this minute, failed joins these 10 minutes
  const tally = (ip) => {
    const now = Date.now();
    let r = recent.get(ip);
    if (!r) recent.set(ip, (r = { minute: now, rooms: 0, window: now, fails: 0 }));
    if (now - r.minute > 60_000) { r.minute = now; r.rooms = 0; }
    if (now - r.window > 600_000) { r.window = now; r.fails = 0; }
    return r;
  };
  const log = (...a) => opts.log && console.log(new Date().toISOString(), ...a);

  const send = (ws, type, m = {}) => ws?.send(JSON.stringify({ type, ...m }));
  const other = (room, p) => room.players.find((q) => q !== p);
  const live = (room) => room.s && !room.over;
  const roomMsg = (room, p) => ({
    code: room.code, seat: p.seat, token: p.token, match: room.match,
    players: room.players.map((q) => ({ name: q.name, seat: q.seat, online: !!q.ws, rematch: q.rematch })),
  });
  const announce = (room) => { for (const p of room.players) send(p.ws, 'room', roomMsg(room, p)); };
  // a match as seat p sees it: the deck lists without their order, its own opening hand and every action with the
  // cards it drew (engine/hidden.js); the order the decks were dealt in stays here
  const startMsg = (room, p) => ({
    decks: room.decks.map(listOf), deal: dealtFor(room.dealt, p.seat), lanes: room.s.terrain, seat: p.seat, cfg: room.s.cfg,
    match: room.match, names: room.seats.map((q) => q.name), actions: room.history.map((h) => ({ a: h.a, r: seen(h.d, p.seat) })),
  });
  // nobody connected and no match running: the room goes after waitMs unless someone comes back
  function emptyCheck(room) {
    clearTimeout(room.empty);
    if (live(room) || room.players.some((p) => p.ws)) return;
    room.empty = setTimeout(() => {
      if (rooms.get(room.code) !== room || live(room) || room.players.some((p) => p.ws)) return;
      for (const p of room.players) clearTimeout(p.grace);
      rooms.delete(room.code);
      log(`room ${room.code} closed: nobody left`);
    }, opts.waitMs);
    room.empty.unref?.();
  }

  function newCode() {
    for (let i = 0; i < 100; i++) {
      const c = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      if (!rooms.has(c)) return c;
    }
    return null;
  }

  function checkDeck(ws, deck) {
    if (!Array.isArray(deck) || deck.length > 60 || deck.some((x) => typeof x !== 'string')) { send(ws, 'error', { reason: 'bad deck: No deck' }); return null; }
    const v = validateDeck(db, deck);
    if (!v.ok) { send(ws, 'error', { reason: `bad deck: ${v.errors.join('; ')}` }); return null; }
    return deck.slice();
  }

  function startMatch(room, swap) {
    const [a, b] = room.players;
    room.seats = swap && room.seats ? [room.seats[1], room.seats[0]] : randomInt(2) ? [b, a] : [a, b];
    room.seats.forEach((p, i) => { p.seat = i; p.rematch = false; });
    room.decks = room.seats.map((p) => p.deck.slice());
    // dealt with the system's cryptographic generator, so no player can work the order out
    room.dealt = deal(db, room.decks, randomInt, opts.engine);
    room.s = room.dealt.s;
    room.history = [];
    room.over = null;
    room.match++;
    for (const p of room.players) { send(p.ws, 'room', roomMsg(room, p)); send(p.ws, 'start', startMsg(room, p)); }
    log(`room ${room.code} match ${room.match} seats ${room.seats.map((p) => p.name).join(' vs ')}`);
  }

  function finish(room, winner, reason) {
    room.over = { winner, reason };
    for (const p of room.players) { clearTimeout(p.grace); p.grace = null; p.rematch = false; send(p.ws, 'over', room.over); }
    log(`room ${room.code} over: ${winner} (${reason})`);
  }

  function detach(ws) {
    const room = ws.room, p = ws.player;
    ws.room = ws.player = null;
    return [room, p];
  }

  // the socket dropped: hold the seat for graceMs while a match is running
  function dropped(ws) {
    const [room, p] = detach(ws);
    if (!room || p.ws !== ws) return;
    p.ws = null;
    room.last = Date.now();
    const q = other(room, p);
    if (live(room)) {
      p.grace = setTimeout(() => { p.grace = null; if (!p.ws && live(room)) finish(room, 1 - p.seat, 'forfeit'); }, opts.graceMs);
      p.grace.unref?.();
      if (q) send(q.ws, 'opponent_left', { graceMs: opts.graceMs });
    } else if (q) send(q.ws, 'opponent_left', { graceMs: 0 });
    if (q) send(q.ws, 'room', roomMsg(room, q));
    emptyCheck(room);
  }

  function leave(ws) {
    const [room, p] = detach(ws);
    if (!room) return;
    clearTimeout(p.grace);
    p.ws = null;
    const q = other(room, p);
    if (live(room) && q && p.seat !== null) finish(room, 1 - p.seat, 'left');
    room.players = room.players.filter((x) => x !== p);
    if (!room.players.length) { clearTimeout(room.empty); rooms.delete(room.code); return; }
    // the one who stays keeps the room, a new opponent can join with the same code; the match that was played is gone
    Object.assign(room, { seats: null, s: null, decks: null, dealt: null, history: [], over: null });
    for (const x of room.players) { x.seat = null; x.rematch = false; }
    send(q.ws, 'opponent_left', { graceMs: 0 });
    announce(room);
  }

  function join(ws, room, deck, name) {
    if (ws.room) leave(ws);
    const p = { name: cleanName(name, ws.name), token: randomBytes(16).toString('base64url'), deck, ws, seat: null, rematch: false, grace: null };
    room.players.push(p);
    ws.room = room; ws.player = p;
    room.last = Date.now();
    if (room.players.length === 2 && room.players.every((x) => x.ws)) startMatch(room, false);
    else announce(room);
  }

  function onAction(ws, m) {
    const room = ws.room, p = ws.player;
    if (!room) return send(ws, 'error', { reason: 'not in a room' });
    if (!room.s) return send(ws, 'reject', { reason: 'no match' });
    if (room.over) return send(ws, 'reject', { reason: 'game over' });
    const s = room.s;
    if (p.seat !== s.active) return send(ws, 'reject', { reason: 'not your turn', n: room.history.length });
    if (m.n !== room.history.length) return send(ws, 'reject', { reason: 'stale', n: room.history.length });
    if (!actionShape(m.a)) return send(ws, 'reject', { reason: 'illegal action', n: room.history.length });
    const want = stable(m.a);
    const a = legalActions(s).find((x) => stable(x) === want);
    if (!a) return send(ws, 'reject', { reason: 'illegal action', n: room.history.length });
    const n = room.history.length;
    let d;
    try { d = play(s, a); }
    catch (e) { log(`room ${room.code} engine error`, e); return finish(room, null, 'error'); }
    room.history.push({ a, d });
    for (const q of room.players) send(q.ws, 'action', { a, n, seat: p.seat, r: seen(d, q.seat) });
    if (s.phase === 'over') finish(room, s.winner, s.endReason);
  }

  // a wrong code and a wrong token get the same answer and count like joins to a missing room, so resumes can not
  // be used to find the codes of open rooms
  function onResume(ws, m) {
    const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
    const room = CODE_RE.test(code) ? rooms.get(code) : null;
    const p = room?.players.find((x) => sameToken(m.token, x.token));
    if (!p) {
      if (++tally(ws.ip).fails > opts.failedJoins) { send(ws, 'error', { reason: 'rate limit' }); return ws.close(1008, 'rate limit'); }
      return send(ws, 'error', { reason: 'unknown room' });
    }
    if (ws.room && ws.player !== p) leave(ws);
    if (p.ws && p.ws !== ws) { const old = p.ws; detach(old); old.close(4000, 'replaced'); }
    const wasAway = !p.ws;
    clearTimeout(p.grace); p.grace = null; clearTimeout(room.empty);
    p.ws = ws; ws.room = room; ws.player = p;
    room.last = Date.now();
    const q = other(room, p);
    if (!room.s && room.players.length === 2 && room.players.every((x) => x.ws)) return startMatch(room, false);
    send(ws, 'room', roomMsg(room, p));
    if (room.s) send(ws, 'start', startMsg(room, p));
    if (room.over) send(ws, 'over', room.over);
    if (q && !q.ws) send(ws, 'opponent_left', { graceMs: q.grace ? opts.graceMs : 0 });
    if (q && wasAway) { send(q.ws, 'opponent_back'); send(q.ws, 'room', roomMsg(room, q)); }
  }

  function onRematch(ws, m) {
    const room = ws.room, p = ws.player;
    if (!room) return send(ws, 'error', { reason: 'not in a room' });
    if (room.players.length < 2) return send(ws, 'error', { reason: 'no opponent' });
    if (!room.s || !room.over) return send(ws, 'error', { reason: 'no finished match' });
    if (m.deck !== undefined) { const d = checkDeck(ws, m.deck); if (!d) return; p.deck = d; }
    p.rematch = true;
    if (room.players.every((x) => x.rematch && x.ws)) startMatch(room, true);
    else announce(room);
  }

  function onMessage(ws, text) {
    // token bucket: refills perSec per second up to burst; past the limit messages are dropped
    const now = Date.now(), r = opts.rate;
    ws.tokens = Math.min(r.burst, ws.tokens + ((now - ws.at) / 1000) * r.perSec);
    ws.at = now;
    if (ws.tokens < 1) {
      if (++ws.strikes > r.burst * 4) return ws.close(1008, 'rate limit');
      if (now - ws.warned > 1000) { ws.warned = now; send(ws, 'error', { reason: 'rate limit' }); }
      return;
    }
    ws.tokens--;
    let m;
    try { m = JSON.parse(text); } catch { return send(ws, 'error', { reason: 'bad json' }); }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return send(ws, 'error', { reason: 'bad message' });
    if (ws.room) ws.room.last = now;
    switch (m.type) {
      case 'ping': return send(ws, 'pong', pingT(m.t));
      case 'hello': ws.name = cleanName(m.name, ws.name); return;
      case 'create': {
        const deck = checkDeck(ws, m.deck);
        if (!deck) return;
        if (rooms.size >= opts.maxRooms) return send(ws, 'error', { reason: 'server full' });
        if (tally(ws.ip).rooms++ >= opts.roomsPerMin) return send(ws, 'error', { reason: 'rate limit' });
        const code = newCode();
        if (!code) return send(ws, 'error', { reason: 'server full' });
        const room = { code, players: [], seats: null, s: null, decks: null, dealt: null, history: [], over: null, match: 0, last: now };
        rooms.set(code, room);
        log(`room ${code} created`);
        return join(ws, room, deck, m.name);
      }
      case 'join': {
        // the deck first, so a bad deck says the same about every code; misses count, so codes can not be guessed
        const deck = checkDeck(ws, m.deck);
        if (!deck) return;
        const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
        const room = CODE_RE.test(code) && rooms.get(code);
        if (ws.room === room && room) return send(ws, 'error', { reason: 'already in this room' });
        if (!room || room.players.length >= 2) {
          if (++tally(ws.ip).fails > opts.failedJoins) { send(ws, 'error', { reason: 'rate limit' }); return ws.close(1008, 'rate limit'); }
          return send(ws, 'error', { reason: room ? 'room full' : 'unknown room' });
        }
        return join(ws, room, deck, m.name);
      }
      case 'action': return onAction(ws, m);
      case 'resume': return onResume(ws, m);
      case 'rematch': return onRematch(ws, m);
      case 'leave': return leave(ws);
      default: return;   // unknown types are ignored
    }
  }

  // every answer carries the game's security headers. Sockets may go to this server (named by its own address too:
  // not every browser takes 'self' to cover ws) and to a room server on this machine
  const HOST_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;
  const headersFor = (req) => {
    const host = HOST_RE.test(req.headers.host ?? '') ? req.headers.host : null;
    return securityHeaders({ https: false, rooms: [...(host ? [`ws://${host}`, `wss://${host}`] : []), 'ws://localhost:*', 'ws://127.0.0.1:*'] });
  };
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(headersFor(req))) res.setHeader(k, v);
    const path = req.url.split('?')[0];
    if (path === '/ws' || path === '/healthz') {
      const body = JSON.stringify({ server: 'latent-legends-rooms', ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    serveStatic(req, res, opts).catch((e) => { log('static error', e); if (!res.headersSent) plain(res, 500, 'Server error\n'); else res.destroy(); });
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (req.url.split('?')[0] !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    if (!originOk(req, opts)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const ip = ipKey(socket.remoteAddress ?? '');
    if (clients.size >= opts.maxClients || (perIp.get(ip) ?? 0) >= opts.perIp) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const ws = upgrade(req, socket, head, opts.maxMsg);
    if (!ws) return;
    Object.assign(ws, { room: null, player: null, name: 'Player', tokens: opts.rate.burst, at: Date.now(), strikes: 0, warned: 0, ip });
    ws.frames = opts.frames; ws.ftokens = opts.frames.burst;
    clients.add(ws);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    // a message that makes a handler throw costs that client its socket, never the server
    ws.onmessage = (text) => { try { onMessage(ws, text); } catch (e) { log('message error', e); ws.close(1011, 'server error'); } };
    ws.onclose = () => {
      clients.delete(ws);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
      dropped(ws);
    };
  });

  // heartbeat: ping every client; one that sent nothing since the last ping is gone
  const beat = setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of recent) if (now - r.minute > 60_000 && now - r.window > 600_000) recent.delete(ip);
    for (const ws of clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.raw(0x9, Buffer.alloc(0));
    }
  }, opts.heartbeatMs);
  beat.unref();

  // rooms with no traffic for idleMs are closed
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (now - room.last < opts.idleMs) continue;
      for (const p of room.players) {
        clearTimeout(p.grace);
        if (p.ws) { send(p.ws, 'error', { reason: 'room expired' }); detach(p.ws); }
      }
      clearTimeout(room.empty);
      rooms.delete(room.code);
      log(`room ${room.code} expired`);
    }
  }, opts.sweepMs);
  sweep.unref();

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, opts.host, () => {
      const port = server.address().port;
      const host = server.address().address, shown = host.includes(':') ? `[${host}]` : host;
      log(`Latent Legends rooms on http://${shown}:${port}/web/play.html (ws /ws)`);
      ok({
        port, server, rooms, clients, opts,
        close: () => new Promise((done) => {
          clearInterval(beat); clearInterval(sweep);
          for (const room of rooms.values()) { clearTimeout(room.empty); for (const p of room.players) clearTimeout(p.grace); }
          for (const ws of clients) ws.terminate();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  startServer({
    port: env.PORT ? +env.PORT : DEFAULTS.port, host: env.HOST || DEFAULTS.host,
    graceMs: env.GRACE_MS ? +env.GRACE_MS : DEFAULTS.graceMs, idleMs: env.IDLE_MS ? +env.IDLE_MS : DEFAULTS.idleMs,
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
