// End to end test of the room server: node server/test_rooms.mjs
// Two Node 22 WebSocket clients play a full greedy-vs-greedy match through the protocol and must end on
// the server's state as far as each seat may see it, never seeing a hidden card; then the rejections, rooms, resume,
// forfeit, rematch, limits, hostile input, raw frames, static files and their headers, and web/net.js (auto reconnect,
// the kept seat) are checked against the same server.
import assert from 'node:assert/strict';
import { connect as tcp } from 'node:net';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { startServer, stateHash, stable, DEFAULTS } from './rooms.mjs';
import { indexCards, newGame, apply, reveal, legalActions, HIDDEN } from '../engine/rules.js';
import { redeal, play } from '../engine/hidden.js';
import { STARTERS } from '../engine/deck.js';
import { BOTS } from '../sim/bots/greedy.js';
import { createNet } from '../web/net.js';

const db = indexCards(JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url))).cards);
const DECK_A = STARTERS.balanced.cards, DECK_B = STARTERS.frost_bastion.cards;
const srv = await startServer({ port: 0, log: false, heartbeatMs: 1500, sweepMs: 200, rate: { burst: 1e6, perSec: 1e6 } });
const URL_WS = `ws://127.0.0.1:${srv.port}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (msg) => { passed++; console.log(`ok ${passed} - ${msg}`); };
const t0 = Date.now();
// what seat may know of a game: everything on the board and in the graves, the sizes of hands and decks, its own hand
const seatHash = (s, seat) => createHash('sha1').update(stable({
  board: s.board, phase: s.phase, active: s.active, winner: s.winner, closed: s.closed, hand: s.players[seat].hand,
  players: s.players.map((p) => ({ shrines: p.shrines, essence: p.essence, grave: p.grave, played: p.played, hand: p.hand.length, deck: p.deck.length })),
})).digest('hex');
// a client never holds a card it may not see: both decks are hidden, and of the opponent's hand only cards that came
// back from the board show
const blind = (s, seat) => s.players.every((p) => p.deck.every((id) => id === HIDDEN));
const startGame = (m) => { const s = newGame(db, m.deal, 0, { ...m.cfg, dealt: true, lanes: m.lanes }); for (const h of m.actions) { reveal(s, h.r); apply(s, h.a); } return s; };

// ---------- a protocol client that keeps its own engine state from 'start' + 'action' ----------
class Client {
  constructor(label) { this.label = label; this.queue = []; this.waiters = []; this.playing = false; this.s = null; this.applied = 0; this.sentAt = -1; }
  open() {
    return new Promise((res, rej) => {
      const ws = (this.ws = new WebSocket(URL_WS));
      ws.onopen = () => res(this);
      ws.onerror = (e) => rej(new Error(`${this.label}: socket error ${e.message ?? ''}`));
      ws.onmessage = (e) => { if (this.ws === ws) this.push(JSON.parse(e.data)); };
      ws.onclose = (e) => { if (this.ws === ws) this.push({ type: '_close', code: e.code }); };
    });
  }
  send(m) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  push(m) {
    if (m.type === 'start') { this.seat = m.seat; this.s = startGame(m); this.applied = m.actions.length; this.sentAt = -1; }
    if (m.type === 'action') {
      assert.equal(m.n, this.applied, `${this.label}: actions arrive in order`);
      reveal(this.s, m.r); apply(this.s, m.a); this.applied++;
      assert.ok(blind(this.s, this.seat), `${this.label}: sees a deck`);
    }
    const w = this.waiters.find((x) => x.type === m.type && x.pred(m));
    if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m); }
    else this.queue.push(m);
    this.onmsg?.(m);
    if (m.type === 'start' || m.type === 'action') this.move();
  }
  // the greedy bot chooses for this seat from the client's own replayed state
  move() {
    const s = this.s;
    if (!this.playing || !s || s.phase === 'over' || s.active !== this.seat || this.sentAt === this.applied) return;
    this.sentAt = this.applied;
    this.send({ type: 'action', a: BOTS.greedy(s), n: this.applied });
  }
  next(type, pred = () => true, ms = 4000) {
    const i = this.queue.findIndex((m) => m.type === type && pred(m));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { type, pred, res, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error(`${this.label}: timed out waiting for '${type}'`)); }, ms) };
      this.waiters.push(w);
    });
  }
  none(type) { return !this.queue.some((m) => m.type === type); }
  close() { this.ws.close(); }
}
const client = async (label) => new Client(label).open();
const room = (code) => srv.rooms.get(code);

// ---------- 1. room setup, bad deck, full room ----------
const A = await client('A'), B = await client('B'), C = await client('C');
A.send({ type: 'create', deck: ['fireball', 'spark'], name: 'Ada' });
assert.match((await A.next('error')).reason, /^bad deck/);
A.send({ type: 'create', deck: [...DECK_A.slice(0, 19), 'not_a_card'], name: 'Ada' });
assert.match((await A.next('error')).reason, /Unknown card: not_a_card/);
ok('bad decks are rejected with the validateDeck reasons');

A.send({ type: 'hello', name: 'Ada' });
A.send({ type: 'create', deck: DECK_A });
const rA = await A.next('room');
assert.match(rA.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
assert.equal(rA.players.length, 1); assert.equal(rA.players[0].name, 'Ada'); assert.ok(rA.token.length >= 20); assert.equal(rA.seat, null);
B.send({ type: 'join', code: ` ${rA.code.toLowerCase()} `, deck: DECK_B, name: 'Bo' });
const [sA, sB] = await Promise.all([A.next('start'), B.next('start')]);
const rB = await B.next('room');
assert.notEqual(rA.token, rB.token);
assert.equal(sA.seed, undefined); assert.deepEqual(sA.decks, sB.decks); assert.deepEqual(sA.names, sB.names);
assert.deepEqual([sA.seat, sB.seat].sort(), [0, 1]);
assert.deepEqual(sA.decks[sA.seat], DECK_A.slice().sort()); assert.deepEqual(sB.decks[sB.seat], DECK_B.slice().sort());
assert.deepEqual(sA.names[sA.seat], 'Ada'); assert.equal(sA.actions.length, 0);
// each sees its own opening hand and nothing of the other's
const shown = (m, p) => m.deal[p].filter((id) => id !== HIDDEN).length;
assert.equal(shown(sA, 1 - sA.seat), 0); assert.equal(shown(sB, 1 - sB.seat), 0);
assert.equal(shown(sA, sA.seat), room(rA.code).dealt.opening[sA.seat].length);
// the room deals from an order it made itself: it holds no seed to find, and its game never shuffled
assert.equal(room(rA.code).seed, undefined); assert.equal(room(rA.code).s.cfg.dealt, true); assert.equal(room(rA.code).s.rng, 1);
assert.deepEqual(room(rA.code).dealt.dealt.map((d) => d.slice().sort()), sA.decks);
ok(`room ${rA.code} created, joined lower case, both got start (Ada on seat ${sA.seat}); no seed, deck order or opponent hand sent`);

C.send({ type: 'join', code: rA.code, deck: DECK_A, name: 'Cy' });
assert.equal((await C.next('error')).reason, 'room full');
C.send({ type: 'join', code: 'ZZZZZ', deck: DECK_A });
assert.equal((await C.next('error')).reason, 'unknown room');
ok('joining a full room fails, an unknown code fails');

// ---------- 2. rejections ----------
const active = A.s.active === A.seat ? A : B, waiting = active === A ? B : A;
waiting.send({ type: 'action', a: legalActions(waiting.s)[0], n: 0 });
assert.equal((await waiting.next('reject')).reason, 'not your turn');
active.send({ type: 'action', a: { t: 'play', id: 'meteor', lane: 0 }, n: 0 });
assert.equal((await active.next('reject')).reason, 'illegal action');
active.send({ type: 'action', a: { t: 'end', extra: 1 }, n: 0 });
assert.equal((await active.next('reject')).reason, 'illegal action');
active.send({ type: 'action', a: { t: 'end' }, n: 3 });
const stale = await active.next('reject');
assert.equal(stale.reason, 'stale'); assert.equal(stale.n, 0);
active.send({ type: 'frobnicate', x: 1 });
active.send('not json');
assert.equal((await active.next('error')).reason, 'bad json');
assert.equal(room(rA.code).history.length, 0);
ok('wrong seat, illegal, extra-field and stale actions are rejected; unknown types ignored');

// ---------- 3. full match with a disconnect and resume in the middle ----------
let dropAt = 20, opLeft = null;
B.onmsg = (m) => {
  if (m.type === 'action' && B.applied === dropAt && B.playing) { B.playing = false; dropAt = -1; setTimeout(() => B.close(), 0); }
};
A.playing = B.playing = true;
active.move();
opLeft = await A.next('opponent_left', () => true, 10000);
assert.equal(opLeft.graceMs, DEFAULTS.graceMs);
const missedFrom = B.applied;
await sleep(150);   // A keeps playing its turn while B is away
const B2 = await client('B2');
B2.playing = true;
B2.send({ type: 'resume', code: rA.code.toLowerCase(), token: 'wrong-token-wrong-token' });
assert.equal((await B2.next('error')).reason, 'unknown room');
B2.send({ type: 'resume', code: rA.code, token: rB.token });
const resumed = await B2.next('start');
assert.equal(resumed.seat, sB.seat); assert.ok(resumed.actions.length >= missedFrom);
await A.next('opponent_back');
ok(`B dropped after ${missedFrom} actions, A was told (grace ${opLeft.graceMs} ms), B resumed and replayed ${resumed.actions.length} actions`);

const [oA, oB] = await Promise.all([A.next('over', () => true, 30000), B2.next('over', () => true, 30000)]);
const R = room(rA.code);
assert.deepEqual(oA, oB);
assert.equal(R.s.phase, 'over'); assert.equal(oA.winner, R.s.winner); assert.equal(oA.reason, R.s.endReason);
const hS = stateHash(R.s);
assert.equal(seatHash(A.s, A.seat), seatHash(R.s, A.seat)); assert.equal(seatHash(B2.s, B2.seat), seatHash(R.s, B2.seat));
assert.equal(A.applied, R.history.length); assert.equal(B2.applied, R.history.length);
const replay = redeal(db, R.dealt.dealt, R.dealt.lanes, srv.opts.engine).s; for (const h of R.history) play(replay, h.a);
assert.equal(stateHash(replay), hS);
ok(`full match over after ${R.history.length} actions: winner ${oA.winner} (${oA.reason}); A and B agree with the server on all they may see`);
const order1 = JSON.stringify(R.dealt.dealt);

// ---------- 4. rematch: a new deal, seats swap; then leaving mid match forfeits ----------
A.playing = B2.playing = false;
A.send({ type: 'rematch' });
const wantR = await B2.next('room', (m) => m.players.some((p) => p.rematch));
assert.ok(wantR.players.find((p) => p.name === 'Ada').rematch);
B2.send({ type: 'rematch' });
const [mA, mB] = await Promise.all([A.next('start', (m) => m.match === 2), B2.next('start', (m) => m.match === 2)]);
assert.equal(mA.seat, 1 - sA.seat); assert.equal(mB.seat, 1 - sB.seat); assert.notEqual(JSON.stringify(room(rA.code).dealt.dealt), order1);
assert.deepEqual(mA.decks[mA.seat], DECK_A.slice().sort());
ok(`rematch: both asked, a new deal, seats swapped (Ada now ${mA.seat})`);
A.send({ type: 'leave' });
const lo = await B2.next('over', (m) => m.reason === 'left');
assert.equal(lo.winner, mB.seat);
await B2.next('opponent_left', (m) => m.graceMs === 0);
ok('leaving mid match: the opponent wins (reason left)');
// the one who stayed takes the seat back on a new socket: the room waits for a new opponent and the old match is gone
const B4 = await client('B4');
B4.send({ type: 'resume', code: rA.code, token: rB.token });
const waitingRoom = await B4.next('room');
assert.equal(waitingRoom.players.length, 1); assert.equal(waitingRoom.seat, null);
assert.equal((await B2.next('_close')).code, 4000);
B4.send({ type: 'rematch' });
assert.equal((await B4.next('error')).reason, 'no opponent');
B4.send({ type: 'ping', t: 4 });
assert.deepEqual(await B4.next('pong'), { type: 'pong', t: 4 });
assert.ok(B4.none('start') && B4.none('_close')); assert.equal(room(rA.code).s, null);
ok('after the opponent left, the player who stayed resumes into a waiting room: no match, and the socket stays open');
B4.send({ type: 'leave' });
await sleep(50);
assert.equal(room(rA.code), undefined);

// ---------- 5. forfeit after the grace period ----------
srv.opts.graceMs = 300;
const D = await client('D'), E = await client('E');
D.send({ type: 'create', deck: DECK_A, name: 'Di' });
const rD = await D.next('room');
E.send({ type: 'join', code: rD.code, deck: DECK_A, name: 'Ed' });
await D.next('start'); const sE = await E.next('start'); const rE = await E.next('room');
const tDrop = Date.now();
E.close();
assert.equal((await D.next('opponent_left')).graceMs, 300);
const fo = await D.next('over');
const waited = Date.now() - tDrop;
assert.equal(fo.reason, 'forfeit'); assert.equal(fo.winner, 1 - sE.seat); assert.ok(waited >= 280, `forfeit came after ${waited} ms`);
const E2 = await client('E2');
E2.send({ type: 'resume', code: rD.code, token: rE.token });
await E2.next('start'); assert.equal((await E2.next('over')).reason, 'forfeit');
ok(`dropped player forfeits after the grace (${waited} ms); resuming later shows the result`);
srv.opts.graceMs = DEFAULTS.graceMs;

// ---------- 6. abuse limits: rate, size ----------
srv.opts.rate = { burst: 20, perSec: 10 };
const F = await client('F');
for (let i = 0; i < 60; i++) F.send({ type: 'ping', t: i });
assert.equal((await F.next('error')).reason, 'rate limit');
await sleep(100);
const pongs = F.queue.filter((m) => m.type === 'pong').length;
assert.ok(pongs >= 20 && pongs < 30, `${pongs} pongs`);
ok(`rate limit: ${pongs} of 60 burst pings answered, then an error`);
srv.opts.rate = { burst: 1e6, perSec: 1e6 };
const G = await client('G');
G.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(DEFAULTS.maxMsg + 10) }));
assert.equal((await G.next('_close')).code, 1009);
ok('a message over maxMsg closes the socket with 1009');

// ---------- 6b. hostile input: none of it may stop the server ----------
const deep = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { a: v }; return v; };
const K = await client('K');
K.send(`{"type":"ping","t":${'['.repeat(7000)}1${']'.repeat(7000)}}`);
assert.deepEqual(await K.next('pong'), { type: 'pong' });
K.send({ type: 'resume', code: 'ZZZZZ', token: 'é'.repeat(11) });
K.send({ type: 'create', deck: DECK_A, name: 'Kit\u202e\u200bevil<b>' });
const rK = await K.next('room');
assert.equal(rK.players[0].name, 'Kitevilb');
const L = await client('L');
L.send({ type: 'resume', code: rK.code, token: 'é'.repeat(rK.token.length / 2) + 'x'.repeat(rK.token.length % 2) });
assert.equal((await L.next('error')).reason, 'unknown room');
L.send({ type: 'join', code: rK.code, deck: DECK_B, name: 'Lu' });
const sK = await K.next('start'), sL = await L.next('start');
const mover = sK.seat === K.s.active ? K : L;
mover.send(JSON.stringify({ type: 'action', a: deep(2000, 'end'), n: 0 }));
assert.equal((await mover.next('reject')).reason, 'illegal action');
mover.send({ type: 'action', a: { t: 'end', x: [[[[1]]]] }, n: 0 });
assert.equal((await mover.next('reject')).reason, 'illegal action');
assert.ok((await fetch(`http://127.0.0.1:${srv.port}/ws`)).ok);
ok('deep ping t, a non-ASCII token, a 2000 deep action and bidi characters in a name: answered, and the server stays up');
K.send({ type: 'leave' }); L.send({ type: 'leave' });

// a page from another site may not open a socket; this server's own pages and local pages may
const upgradeStatus = (origin) => new Promise((res) => {
  const s = tcp(srv.port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`));
  s.on('data', (d) => { res(+d.toString().split(' ')[1]); s.destroy(); });
});
assert.equal(await upgradeStatus('https://evil.example'), 403);
assert.equal(await upgradeStatus(`http://127.0.0.1:${srv.port}`), 101);
assert.equal(await upgradeStatus('http://192.168.1.20:8000'), 101);
ok('Origin: another site gets 403, the server\'s own and local network pages get in');

// guessing room codes: misses count, and too many close the socket
srv.opts.failedJoins = 5;
const M = await client('M');
for (let i = 0; i < 7; i++) M.send({ type: 'join', code: `ZZZZ${'ABCDEFG'[i]}`, deck: DECK_A });
assert.equal((await M.next('error', (m) => m.reason === 'rate limit')).reason, 'rate limit');
assert.equal((await M.next('_close')).code, 1008);
ok('more than failedJoins misses from one address: rate limit, then the socket closes');
// a resume of no seat counts as a miss too, and says the same of an open room and of a code nobody has
const O = await client('O'), O2 = await client('O2');
O.send({ type: 'create', deck: DECK_A, name: 'Oz' });
const rO = await O.next('room');
srv.opts.failedJoins = 1e6;
O2.send({ type: 'resume', code: rO.code, token: 'x'.repeat(22) });
const missOpen = await O2.next('error');
O2.send({ type: 'resume', code: 'ZZZZZ', token: 'x'.repeat(22) });
assert.deepEqual(await O2.next('error'), missOpen); assert.equal(missOpen.reason, 'unknown room');
srv.opts.failedJoins = 5;
O2.send({ type: 'resume', code: rO.code, token: 'y'.repeat(22) });
assert.equal((await O2.next('error')).reason, 'rate limit');
assert.equal((await O2.next('_close')).code, 1008);
srv.opts.failedJoins = 1e6;
O.send({ type: 'leave' });
ok('a wrong resume answers unknown room whether the room is open or not, and counts toward failedJoins');

// a room nobody is connected to goes after waitMs
srv.opts.waitMs = 200;
const N = await client('N');
N.send({ type: 'create', deck: DECK_A, name: 'Ny' });
const rN = await N.next('room');
N.close();
await sleep(400);
assert.equal(room(rN.code), undefined);
srv.opts.waitMs = DEFAULTS.waitMs;
ok('an empty waiting room is closed after waitMs');

// ---------- 7. raw frames over node:net: handshake, fragments, control frames, protocol errors, heartbeat ----------
function raw() {
  return new Promise((res, rej) => {
    const key = randomBytes(16).toString('base64');
    const sock = tcp(srv.port, '127.0.0.1');
    let buf = Buffer.alloc(0), shook = false;
    const r = { sock, frames: [], waiters: [], ended: false, status: null };
    const pump = () => {
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const f = { fin: !!(buf[0] & 0x80), op: buf[0] & 0x0f, data: buf.subarray(off, off + len), masked: !!(buf[1] & 0x80) };
        buf = buf.subarray(off + len);
        const w = r.waiters.shift();
        if (w) w(f); else r.frames.push(f);
      }
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!shook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4); shook = true;
        r.status = +head.split(' ')[1];
        r.accept = /sec-websocket-accept: (\S+)/i.exec(head)?.[1];
        r.expect = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        res(r);
      }
      pump();
    });
    sock.on('close', () => { r.ended = true; for (const w of r.waiters.splice(0)) w(null); });
    sock.on('error', rej);
    const take = (ms) => (r.frames.length ? Promise.resolve(r.frames.shift()) : r.ended ? Promise.resolve(null) : new Promise((ok2, no) => { const t = setTimeout(() => no(new Error('raw: no frame')), ms); r.waiters.push((f) => { clearTimeout(t); ok2(f); }); }));
    // heartbeat pings can arrive at any time; skip them unless asked for
    r.next = async (ms = 3000, pings = false) => { for (;;) { const f = await take(ms); if (!f || pings || f.op !== 9) return f; } };
    r.closed = () => new Promise((ok2) => (r.ended ? ok2() : sock.on('close', ok2)));
    sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}
const frame = (op, payload, { fin = true, mask = true } = {}) => {
  const data = Buffer.from(payload), len = data.length, k = mask ? randomBytes(4) : Buffer.alloc(0);
  const head = len < 126 ? [(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | len] : [(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 126, len >> 8, len & 255];
  if (mask) for (let i = 0; i < len; i++) data[i] ^= k[i & 3];
  return Buffer.concat([Buffer.from(head), k, data]);
};
const closeCode = (f) => f && f.op === 8 && f.data.readUInt16BE(0);

let w = await raw();
assert.equal(w.status, 101); assert.equal(w.accept, w.expect);
w.sock.write(Buffer.concat([
  frame(1, '{"type":"pi', { fin: false }), frame(9, 'hb'), frame(0, 'ng","t":', { fin: false }), frame(0, '7}'),
]));
let f = await w.next();
assert.equal(f.op, 0xa); assert.equal(f.data.toString(), 'hb'); assert.equal(f.masked, false);
f = await w.next();
assert.equal(f.op, 1); assert.deepEqual(JSON.parse(f.data), { type: 'pong', t: 7 });
const closeBody = Buffer.alloc(5); closeBody.writeUInt16BE(1000, 0); closeBody.write('bye', 2);
w.sock.write(frame(8, closeBody));
assert.equal(closeCode(await w.next()), 1000);
await w.closed();
ok('handshake accept key, fragmented text with a ping in between, pong, close handshake');

// a client that ends its side without a close frame gives its place back at once, not at the next heartbeat
const openBefore = srv.clients.size;
w = await raw();
assert.equal(srv.clients.size, openBefore + 1);
w.sock.end();
await w.closed();
await sleep(50);
assert.equal(srv.clients.size, openBefore);
ok('a socket ended without a close frame is released at once');

w = await raw(); w.sock.write(frame(1, '{"type":"ping"}', { mask: false }));
assert.equal(closeCode(await w.next()), 1002);
w = await raw(); w.sock.write(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0]));   // claims 1 MB, sends nothing
assert.equal(closeCode(await w.next()), 1009);
w = await raw(); w.sock.write(frame(1, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
assert.equal(closeCode(await w.next()), 1007);
w = await raw(); w.sock.write(frame(0, 'x'));
assert.equal(closeCode(await w.next()), 1002);
w = await raw(); w.sock.write(frame(2, 'bin'));
assert.equal(closeCode(await w.next()), 1003);
ok('unmasked 1002, oversize header 1009 before the payload, bad UTF-8 1007, stray continuation 1002, binary 1003');

// floods of frames that carry no message: empty continuations, then pings
w = await raw(); w.sock.write(Buffer.concat([frame(1, '{', { fin: false }), ...Array.from({ length: 100 }, () => frame(0, '', { fin: false }))]));
assert.equal(closeCode(await w.next()), 1009);
w = await raw(); w.sock.write(Buffer.concat(Array.from({ length: 2000 }, () => frame(9, ''))));
let code = null;
for (let i = 0; i < 2100 && code === null; i++) { const g = await w.next(3000, true); if (!g) break; if (g.op === 8) code = closeCode(g); }
assert.equal(code, 1008);
ok('100 empty continuation frames: 1009; 2000 pings at once: 1008');

w = await raw();
f = await w.next(2500, true);
assert.equal(f.op, 9);
const tSilent = Date.now();
await w.closed();
ok(`heartbeat: server pings, a client that never answers is dropped (${Date.now() - tSilent} ms after the first ping)`);

const bad = await new Promise((res) => {
  const s = tcp(srv.port, '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
  s.on('data', (d) => { res(d.toString().split('\r\n')[0]); s.destroy(); });
});
assert.match(bad, /^HTTP\/1.1 400/);
ok('upgrade without a key gets 400');

// ---------- 8. static files ----------
const get = (path, headers = {}) => new Promise((res, rej) => {
  const req = request({ host: '127.0.0.1', port: srv.port, path, headers }, (r) => { let body = ''; r.on('data', (d) => (body += d)); r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body, headers: r.headers })); });
  req.on('error', rej); req.end();
});
let r = await get('/web/play.html');
assert.equal(r.status, 200); assert.match(r.type, /^text\/html/);
assert.match((await get('/engine/rules.js')).type, /^text\/javascript/);
assert.match((await get('/web/net.js')).type, /^text\/javascript/);
assert.match((await get('/data/cards.json')).type, /^application\/json/);
assert.equal((await get('/web/assets/board_clean.webp')).type, 'image/webp');
for (const p of ['/package.json', '/RULES.md', '/server/rooms.mjs', '/web/../package.json', '/web/%2e%2e/package.json', '/web/..%2fpackage.json', '/engine/%2e%2e%2fRULES.md', '/web/.hidden', '/etc/passwd', '//etc/passwd'])
  assert.equal((await get(p)).status, 404, p);
assert.equal((await get('/')).status, 302);
r = await get('/web/assets');
assert.equal(r.status, 301); assert.equal(r.headers.location, '/web/assets/');
r = await get('//web');
assert.equal(r.status, 301); assert.equal(r.headers.location, '/web/');
r = await get('/web/assets/');
const listed = new Set([...r.body.matchAll(/href="([^"?/]+)\/?"/g)].map((m) => decodeURIComponent(m[1])));
assert.ok(listed.has('sprites.json') && listed.has('sfx'), [...listed].join(','));
r = await get('/web/assets/board_clean.webp', { range: 'bytes=0-9' });
assert.equal(r.status, 206); assert.equal(r.headers['content-length'], '10');
r = await get('/ws');
assert.deepEqual(JSON.parse(r.body), { server: 'latent-legends-rooms', ok: true });
ok('static: MIME types, 404 for traversal and files outside web/engine/sim/data, listings, ranges, /ws info');

// every answer carries the security headers; the server listens on this machine only unless told otherwise
for (const path of ['/web/play.html', '/web/assets/', '/ws', '/package.json']) {
  r = await get(path);
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /(^|; )script-src 'self'(;|$)/, path); assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/, path);
  assert.ok(csp.includes(`connect-src 'self' ws://127.0.0.1:${srv.port} wss://127.0.0.1:${srv.port} ws://localhost:* ws://127.0.0.1:*;`), csp);
  assert.ok(!csp.includes('upgrade-insecure-requests'), path);
  assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin'); assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
}
r = await get('/web/play.html', { host: 'x; script-src *' });
assert.ok(!r.headers['content-security-policy'].includes('script-src *') && r.headers['content-security-policy'].includes("connect-src 'self' ws://localhost:*"));
assert.equal(srv.server.address().address, '127.0.0.1'); assert.equal(DEFAULTS.host, '127.0.0.1');
ok('security headers on pages, listings, /ws and errors; a strange Host stays out of the policy; bound to 127.0.0.1 by default');

// ---------- 9. web/net.js: two browser-module clients, one dropped by the server and auto reconnected ----------
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
function netBot(net, label) {
  const me = { s: null, rejects: 0, starts: 0 };
  const move = () => { if (me.s && me.s.phase !== 'over' && me.s.active === net.state.seat) net.sendAction(BOTS.greedy(me.s)); };
  net.on('start', (m) => { me.starts++; me.s = startGame(m); move(); });
  net.on('action', (m) => { reveal(me.s, m.r); apply(me.s, m.a); move(); });
  net.on('reject', () => { me.rejects++; });
  me.over = new Promise((res) => net.on('over', res));
  me.label = label;
  return me;
}
const store1 = mem(), store2 = mem();
const n1 = createNet({ url: `127.0.0.1:${srv.port}`, storage: store1 }), n2 = createNet({ url: URL_WS, storage: store2 });
const b1 = netBot(n1, 'n1'), b2 = netBot(n2, 'n2');
const statuses = [];
n2.on('status', (m) => statuses.push(m.status));
const roomed = new Promise((res) => n1.on('room', res));
n1.createRoom(DECK_B, 'Net One');
const nr = await roomed;
assert.equal(n1.state.url, URL_WS);
assert.equal(JSON.parse(store1.getItem('latent.room')).token, nr.token);
let dropped = false;
n2.on('action', () => {
  if (dropped || n2.state.history.length !== 30) return;
  dropped = true;
  room(nr.code).players.find((p) => p.token === n2.state.token).ws.terminate();   // the server side cuts the TCP link
});
n2.joinRoom(nr.code.toLowerCase(), DECK_A, 'Net Two');
const [no1, no2] = await Promise.all([b1.over, b2.over]);
const NR = room(nr.code);
assert.ok(dropped); assert.ok(statuses.includes('reconnecting')); assert.equal(b2.starts, 2);
assert.deepEqual(no1, no2);
assert.equal(seatHash(b1.s, n1.state.seat), seatHash(NR.s, n1.state.seat)); assert.equal(seatHash(b2.s, n2.state.seat), seatHash(NR.s, n2.state.seat));
assert.equal(n1.state.history.length, NR.history.length); assert.equal(n2.state.history.length, NR.history.length);
ok(`net.js: match over after ${NR.history.length} actions, n2 cut at 30 and auto resumed (${statuses.join(' > ')}), states match the server`);
n1.leave(); n2.close();
assert.equal(store1.getItem('latent.room'), null);

// a kept seat goes back only to the room server that gave it out
const P = await client('P');
P.send({ type: 'create', deck: DECK_A, name: 'Pa' });
const rP = await P.next('room');
P.close();
await sleep(50);
assert.equal(JSON.parse(store2.getItem('latent.room')).url, URL_WS);
const elsewhere = mem(), here = mem();
elsewhere.setItem('latent.room', JSON.stringify({ code: rP.code, token: rP.token, url: 'ws://127.0.0.1:1/ws' }));
here.setItem('latent.room', JSON.stringify({ code: rP.code, token: rP.token, url: URL_WS }));
const sockets = srv.clients.size;
const n3 = createNet({ url: URL_WS, storage: elsewhere });
assert.equal(n3.state.token, rP.token);
n3.resume();
await sleep(150);
assert.equal(n3.state.token, null); assert.equal(n3.state.status, 'idle'); assert.equal(elsewhere.getItem('latent.room'), null);
assert.equal(srv.clients.size, sockets); assert.equal(room(rP.code).players[0].ws, null);
const n4 = createNet({ url: URL_WS, storage: here });
const mine = new Promise((res) => n4.on('room', res));
n4.resume();
assert.equal((await mine).code, rP.code); assert.ok(room(rP.code).players[0].ws);
ok('net.js: a seat kept for another room server is dropped unsent; one kept for this server is resumed');

// a link the server closes straight after taking it, again and again: the waits grow and the client gives up
const tries = [];
const n4b = createNet({ url: URL_WS, storage: here, retryMs: 8 });
const lostB = new Promise((res) => n4b.on('error', (m) => m.reason === 'connection lost' && res()));
n4.close();
await sleep(50);
const others = new Set(srv.clients);
n4b.on('status', (m) => {
  if (m.status !== 'open') return;
  tries.push(Date.now());
  setTimeout(() => { for (const ws of srv.clients) if (!others.has(ws)) ws.close(1011, 'server error'); }, 3);
});
n4b.resume();
await Promise.race([lostB, sleep(4000)]);
assert.equal(tries.length, 5, `${tries.length} tries`);
assert.equal(n4b.state.status, 'idle'); assert.equal(n4b.state.token, null); assert.equal(here.getItem('latent.room'), null);
const gaps = tries.slice(1).map((t, i) => t - tries[i]);
assert.ok(gaps[3] > gaps[0], `waits ${gaps.join(', ')} ms`);
await sleep(200);
assert.equal(tries.length, 5);
ok(`net.js: five links closed by the server in a row (waits ${gaps.join(', ')} ms), then the client stops and forgets the seat`);

// ---------- 10. idle rooms are cleaned up ----------
const H = await client('H');
H.send({ type: 'create', deck: DECK_A, name: 'Hu' });
const rH = await H.next('room');
srv.opts.idleMs = 300;
assert.equal((await H.next('error', () => true, 2000)).reason, 'room expired');
assert.equal(room(rH.code), undefined);
ok(`idle room ${rH.code} expired and was removed`);

for (const c of [A, B2, B4, C, D, E2, F, H, K, L, O]) c.close();
await srv.close();
console.log(`\nall ${passed} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(0);
