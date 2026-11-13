// End to end test of the Cloudflare room server. Start it first with a short grace, then run the test:
//   npx wrangler dev --port 8787 --var GRACE_MS:3000      then      node test_worker.mjs [ws://127.0.0.1:8787/ws]
// Against the deployed rooms (60 s grace): GRACE_MS=60000 node test_worker.mjs <the address in rooms.url>
// The turn clock check runs only with a short clock: --var TURN_MS:3000 on the dev server and TURN_MS=3000 here; the
// check that a socket with no seat is closed runs only with --var JOIN_MS:2000 there and JOIN_MS=2000 here.
// Two clients play a full greedy-vs-greedy match through the protocol and must agree on everything both may see,
// never seeing a hidden card; then room errors, resume, a second tab, leave, forfeit, rematch, the origin check,
// hostile input, web/net.js and the caps on matches dropped at their start are checked.
// On the dev server every client here comes from an address of its own (a CF-Connecting-IP header). The deployed rooms
// see this machine's real address instead, and the matches this test ends early count against it for the day.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { indexCards, newGame, apply, reveal, HIDDEN } from '../engine/rules.js';
import { STARTERS } from '../engine/deck.js';
import { BOTS } from '../sim/bots/greedy.js';
import { createNet } from '../web/net.js';

const BASE = process.argv[2] ?? 'ws://127.0.0.1:8787/ws';
const GRACE = +(process.env.GRACE_MS ?? 3000);
const db = indexCards(JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url))).cards);
const DECK_A = STARTERS.balanced.cards, DECK_B = STARTERS.frost_bastion.cards;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (q) => `${BASE}${q}`;
// what both players may see: the board, the graves, and only the sizes of hands and decks
const view = (s) => JSON.stringify({
  board: s.board, phase: s.phase, active: s.active, winner: s.winner,
  players: s.players.map((p) => ({ shrines: p.shrines, essence: p.essence, grave: p.grave, played: p.played, hand: p.hand.length, deck: p.deck.length })),
});
const blind = (s) => s.players.every((p) => p.deck.every((id) => id === HIDDEN));
const startGame = (m) => { const s = newGame(db, m.deal, 0, { ...m.cfg, dealt: true, lanes: m.lanes }); for (const h of m.actions) { reveal(s, h.r); apply(s, h.a); } return s; };
let passed = 0;
const ok = (msg) => { passed++; console.log(`ok ${passed} - ${msg}`); };
const t0 = Date.now();

// a protocol client that keeps its own engine state from 'start' + 'action' and plays greedy when asked
class Client {
  constructor(label) { this.label = label; this.queue = []; this.waiters = []; this.playing = false; this.s = null; this.applied = 0; this.sentAt = -1; }
  open(query, headers) {
    return new Promise((res, rej) => {
      const ws = (this.ws = new WebSocket(at(query), headers ? { headers } : undefined));
      // pings like web/net.js: the room closes sockets that stay silent
      const pinger = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 20000);
      ws.onopen = () => res(this);
      ws.onerror = () => rej(new Error(`${this.label}: socket error`));
      ws.onmessage = (e) => { if (this.ws === ws) this.push(JSON.parse(e.data)); };
      ws.onclose = (e) => { clearInterval(pinger); if (this.ws === ws) this.push({ type: '_close', code: e.code }); };
    });
  }
  send(m) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  push(m) {
    if (m.type === 'room') { this.token = m.token; this.code = m.code; }
    if (m.type === 'start') { assert.equal(m.seed, undefined); this.seat = m.seat; this.s = startGame(m); this.applied = m.actions.length; this.sentAt = -1; }
    if (m.type === 'action') {
      assert.equal(m.n, this.applied, `${this.label}: actions arrive in order`);
      reveal(this.s, m.r); apply(this.s, m.a); this.applied++;
      assert.ok(blind(this.s), `${this.label}: sees a deck`);
    }
    const w = this.waiters.find((x) => x.type === m.type && x.pred(m));
    if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m); }
    else this.queue.push(m);
    if (m.type === 'start' || m.type === 'action') this.move();
  }
  move() {
    const s = this.s;
    if (!this.playing || !s || s.phase === 'over' || s.active !== this.seat || this.sentAt === this.applied) return;
    if (this.stopAt !== undefined && this.applied >= this.stopAt) return;
    this.sentAt = this.applied;
    this.send({ type: 'action', a: BOTS.greedy(s), n: this.applied });
  }
  next(type, pred = () => true, ms = 8000) {
    const i = this.queue.findIndex((m) => m.type === type && pred(m));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { type, pred, res, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error(`${this.label}: timed out waiting for '${type}'`)); }, ms) };
      this.waiters.push(w);
    });
  }
  close() { this.ws.close(); }
}
// each client its own address, different on every run (the dev server keeps the day's counts between runs)
const RUN = Math.floor(Math.random() * 250) + 1;
let clients = 0;
const address = () => ({ 'CF-Connecting-IP': `198.18.${RUN}.${(clients++ % 250) + 1}` });
const client = (label, query, headers = address()) => new Client(label).open(query, headers);

// two players in a fresh room, match started
async function pair(nameA = 'Ada', nameB = 'Bo') {
  const A = await client('A', '?new=1');
  A.send({ type: 'create', deck: DECK_A, name: nameA });
  const { code } = await A.next('room');
  const B = await client('B', `?room=${code}`);
  B.send({ type: 'join', code: code.toLowerCase(), deck: DECK_B, name: nameB });
  await Promise.all([A.next('start'), B.next('start')]);
  return { A, B, code };
}

// ---------- 1. info, bad deck, unknown and full rooms ----------
const info = await (await fetch(BASE.replace(/^ws/, 'http'))).json();
assert.equal(info.server, 'latent-legends-rooms');
const X = await client('X', '?new=1');
X.send({ type: 'create', deck: ['fireball', 'spark'] });
assert.match((await X.next('error')).reason, /^bad deck/);
X.send({ type: 'create', deck: [...DECK_A.slice(0, 19), 'not_a_card'] });
assert.match((await X.next('error')).reason, /Unknown card: not_a_card/);
X.close();
const U = await client('U', '?room=ZZZZZ');
U.send({ type: 'join', code: 'ZZZZZ', deck: DECK_B });
assert.equal((await U.next('error')).reason, 'unknown room');
const M = await client('M', '?room=ab-c');
M.send({ type: 'join', code: 'ab-c', deck: DECK_B });
assert.equal((await M.next('error')).reason, 'unknown room');
const P = await client('P', '');
P.send({ type: 'create', deck: DECK_A });
assert.match((await P.next('error')).reason, /new=1/);
U.close(); M.close(); P.close();
ok('server info; bad decks rejected with the validateDeck reasons; unknown, malformed and missing room codes answer unknown room');

// ---------- 1b. hostile input ----------
// a client can not pick its own room code by sending the header the Worker uses inside
const Q = await client('Q', '?room=QQQQQ', { 'X-Room-New': '1', 'X-Room-Code': 'QQQQQ' });
Q.send({ type: 'create', deck: DECK_A });
assert.match((await Q.next('error')).reason, /new=1/);
Q.close();
{
  const { A: HA, B: HB } = await pair('Hy\u202e\u200bde<i>', 'Hb');
  const deep = (n) => { let v = 'end'; for (let i = 0; i < n; i++) v = { a: v }; return v; };
  HA.send(`{"type":"ping","t":${'['.repeat(7000)}1${']'.repeat(7000)}}`);
  assert.deepEqual(await HA.next('pong'), { type: 'pong' });
  const mover = HA.s.active === HA.seat ? HA : HB;
  mover.send({ type: 'action', a: deep(2000), n: 0 });
  assert.equal((await mover.next('reject')).reason, 'illegal action');
  const T = await client('T', `?room=${HA.code}`);
  T.send({ type: 'resume', code: HA.code, token: 'é'.repeat(HA.token.length / 2) + 'x'.repeat(HA.token.length % 2) });
  assert.equal((await T.next('error')).reason, 'unknown room');
  T.close();
  // text only, and the size limit is in bytes: 6000 characters of three bytes each are over it
  const Bin = await client('Bin', `?room=${HA.code}`);
  Bin.ws.send(new Uint8Array([1, 2, 3]));
  assert.equal((await Bin.next('_close')).code, 1003);
  const Big = await client('Big', `?room=${HA.code}`);
  Big.send(JSON.stringify({ type: 'ping', pad: '\u20ac'.repeat(6000) }));
  assert.equal((await Big.next('_close')).code, 1009);
  // a socket may send 100 of the messages that change a room; the next one closes it
  const Many = await client('Many', `?room=${HA.code}`);
  for (let i = 0; i < 101; i++) Many.send({ type: 'leave' });
  assert.equal((await Many.next('_close')).code, 1008);
  // the room still plays: a legal move goes through
  mover.send({ type: 'action', a: { t: 'end' }, n: 0 });
  assert.equal((await mover.next('action')).a.t, 'end');
  assert.ok(HA.s.players[1 - HA.seat].hand.every((id) => id === HIDDEN || id === 'spark'));
  HA.close(); HB.close();
}
ok('a spoofed room header, a deep ping, a 2000 deep action, a non-ASCII token, a binary frame (1003), 18 kB in 6000 characters (1009), 101 room requests on one socket (1008): refused or answered, the room keeps playing; the opponent hand stays hidden');

// ---------- 2. a full match, both clients end on the same state ----------
let { A, B, code } = await pair();
assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
assert.notEqual(A.seat, B.seat);
const C = await client('C', `?room=${code}`);
C.send({ type: 'join', code, deck: DECK_A });
assert.equal((await C.next('error')).reason, 'room full');
C.close();
A.send({ type: 'action', a: { t: 'nonsense' }, n: 0 });
const first = A.seat === 0 ? A : B, second = first === A ? B : A;
second.send({ type: 'action', a: { t: 'pass' }, n: 0 });
assert.equal((await second.next('reject')).reason, 'not your turn');
A.playing = B.playing = true; A.move(); B.move();
const [oa, ob] = await Promise.all([A.next('over', () => true, 30000), B.next('over', () => true, 30000)]);
A.playing = B.playing = false;
assert.deepEqual(oa, ob);
assert.equal(view(A.s), view(B.s));
assert.equal(A.s.phase, 'over');
assert.equal(oa.winner, A.s.winner);
ok(`room ${code}: full match over after ${A.applied} actions (${oa.reason}, winner ${oa.winner}), both clients on the same state, room full and not your turn refused`);

// ---------- 3. rematch swaps seats ----------
const seatA = A.seat;
A.send({ type: 'rematch' });
const rr = await B.next('room', (m) => m.players.some((p) => p.rematch));
assert.ok(rr.players.find((p) => p.name === 'Ada').rematch);
B.send({ type: 'rematch' });
const [sa] = await Promise.all([A.next('start'), B.next('start')]);
assert.equal(sa.match, 2); assert.equal(A.seat, 1 - seatA); assert.equal(sa.actions.length, 0);
ok('rematch: both asked, match 2 started with the seats swapped');

// ---------- 4. drop and resume, a second tab, forfeit ----------
A.playing = B.playing = true; A.stopAt = B.stopAt = 12; A.move(); B.move();
while (A.applied < 12 || B.applied < 12) await sleep(50);
B.close();
const left = await A.next('opponent_left', (m) => m.graceMs > 0);
assert.ok(left.graceMs <= GRACE);
const B2 = await client('B2', `?room=${code}`);
B2.send({ type: 'resume', code, token: 'nope' });
assert.equal((await B2.next('error')).reason, 'unknown room');
B2.send({ type: 'resume', code, token: B.token });
const st = await B2.next('start');
assert.equal(st.actions.length, 12); assert.equal(B2.applied, 12);
await A.next('opponent_back');
ok('a drop gives the opponent the grace; a wrong token is refused; the right one takes the seat back with all 12 actions');
const B3 = await client('B3', `?room=${code}`);
B3.send({ type: 'resume', code, token: B.token });
await B3.next('start');
assert.equal((await B2.next('_close')).code, 4000);
ok('a resume from a second tab takes the seat, the old socket closes with 4000');
B3.close();
await A.next('opponent_left', (m) => m.graceMs > 0);
const t1 = Date.now();
const fo = await A.next('over', () => true, GRACE + 15000);
assert.equal(fo.reason, 'forfeit'); assert.equal(fo.winner, A.seat);
ok(`forfeit: the dropped player did not come back, the opponent won ${Date.now() - t1} ms later (grace ${GRACE} ms)`);
A.close();

// ---------- 5. leave ----------
({ A, B, code } = await pair());
A.send({ type: 'leave' });
const lo = await B.next('over');
assert.equal(lo.reason, 'left'); assert.equal(lo.winner, B.seat);
await B.next('opponent_left', (m) => m.graceMs === 0);
// the one who stayed takes the seat back on a new socket: the room waits for a new opponent, the old match is gone
const B5 = await client('B5', `?room=${code}`);
B5.send({ type: 'resume', code, token: B.token });
const waitingRoom = await B5.next('room');
assert.equal(waitingRoom.players.length, 1); assert.equal(waitingRoom.seat, null);
assert.equal((await B.next('_close')).code, 4000);
B5.send({ type: 'rematch' });
assert.equal((await B5.next('error')).reason, 'no opponent');
B5.send({ type: 'ping', t: 5 });
assert.deepEqual(await B5.next('pong'), { type: 'pong', t: 5 });
assert.ok(!B5.queue.some((m) => m.type === 'start' || m.type === '_close'));
// and a new opponent can join with the same code
const N = await client('N', `?room=${code}`);
N.send({ type: 'join', code, deck: DECK_A, name: 'New' });
const [sn] = await Promise.all([N.next('start'), B5.next('start')]);
assert.equal(sn.actions.length, 0); assert.deepEqual(sn.names.slice().sort(), ['Bo', 'New']);
N.send({ type: 'leave' });
await B5.next('over');
B5.send({ type: 'leave' });
await sleep(200);
A.close(); B5.close(); N.close();
const gone = await client('G', `?room=${code}`);
gone.send({ type: 'join', code, deck: DECK_A });
assert.equal((await gone.next('error')).reason, 'unknown room');
gone.close();
ok('leave during a match loses it; the player who stayed resumes into a waiting room and a new opponent joins it; when both have left the room is gone');

// ---------- 5b. turn clock (only with a short clock: TURN_MS=3000 here and --var TURN_MS:3000 on the dev server) ----------
if (process.env.TURN_MS) {
  const TURN = +process.env.TURN_MS;
  ({ A, B, code } = await pair());
  const idle = A.seat === 0 ? A : B, other = idle === A ? B : A;
  // the idle player never moves: after TURN_MS the room ends the turn for them, every move marked auto
  const auto = await other.next('action', (m) => m.auto && m.seat === idle.seat && m.a.t === 'end', TURN + 6000);
  assert.ok(auto.left == null || auto.left > 0);
  // the other player plays a turn normally, then the idle one runs out twice more: three in a row loses
  other.playing = true; other.move();
  const ov = await other.next('over', () => true, TURN * 4 + 20000);
  assert.equal(ov.reason, 'timeout'); assert.equal(ov.winner, other.seat);
  ok(`turn clock: a player who never moves gets the turn played for them after ${TURN} ms, three times in a row loses (timeout)`);
  A.close(); B.close();
}

// ---------- 6. origin check ----------
const status = (origin) => new Promise((res) => {
  const u = new URL(at('?new=1').replace(/^ws/, 'http'));
  const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: origin } });
  req.on('upgrade', (r, sock) => { sock.destroy(); res(r.statusCode); });
  req.on('response', (r) => { r.resume(); res(r.statusCode); });
  req.on('error', () => res(0));
  req.end();
});
assert.equal(await status('https://evil.example'), 403);
assert.equal(await status('https://latent-legends.vercel.app'), 101);
assert.equal(await status('http://localhost:5173'), 101);
ok('origin: other sites get 403, the game and localhost get the socket');

// ---------- 7. web/net.js: create, join, a full match, leave ----------
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const n1 = createNet({ url: BASE, storage: mem() }), n2 = createNet({ url: BASE, storage: mem() });
const play = (net) => {
  let s = null, sent = -1;
  const go = () => { if (s && s.phase !== 'over' && s.active === net.state.seat && sent !== net.state.history.length) { sent = net.state.history.length; net.sendAction(BOTS.greedy(s)); } };
  net.on('start', (m) => { s = startGame(m); sent = -1; go(); });
  net.on('action', (m) => { reveal(s, m.r); apply(s, m.a); go(); });
  return () => s;
};
const s1 = play(n1), s2 = play(n2);
const done = (net) => new Promise((res) => net.on('over', res));
const room1 = new Promise((res) => n1.on('room', res));
n1.createRoom(DECK_A, 'Net one');
const { code: nc } = await room1;
const over = Promise.all([done(n1), done(n2)]);
n2.joinRoom(nc.toLowerCase(), DECK_B, 'Net two');
await over;
assert.equal(view(s1()), view(s2()));
const played = n1.state.history.length;
assert.ok(played > 20); assert.equal(n2.state.history.length, played);
n1.leave(); await sleep(200); n2.leave();
assert.equal(n1.state.status, 'idle');
ok(`net.js: room ${nc} created and joined through ?new=1 and ?room=, match over after ${played} actions, same state, leave closes the socket`);

// ---------- 8. one address can not use up the day's matches: a leave and join loop is stopped after a few starts ----------
// local dev server only: against the deployed rooms the loop would use up this machine's own matches for the day
if (/^wss?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE)) {
  const ip = address();
  const LA = await client('LA', '?new=1', ip);
  LA.send({ type: 'create', deck: DECK_A, name: 'Loop' });
  const { code: lc } = await LA.next('room');
  const LB = await client('LB', `?room=${lc}`, ip);
  let starts = 0, busy = false;
  for (let i = 0; i < 400 && !busy; i++) {
    LB.send({ type: 'join', code: lc, deck: DECK_B, name: 'Loop B' });
    // whichever comes first: the match starts, or the room says the cap is reached
    let m = null;
    for (let k = 0; k < 400 && !m; k++) {
      const j = LB.queue.findIndex((x) => x.type === 'start' || (x.type === 'error' && x.reason === 'busy'));
      if (j >= 0) m = LB.queue.splice(j, 1)[0].type === 'start' ? 'start' : 'busy'; else await sleep(20);
    }
    assert.ok(m, 'no answer to a join');
    if (m === 'busy') busy = true; else { starts++; LB.send({ type: 'leave' }); await LA.next('over'); }
  }
  assert.ok(busy, `no cap after ${starts} starts`);
  // a match left as soon as it starts marks the address that left it; QUICK_PER_IP marks and it starts no more today
  assert.equal(starts, +(process.env.QUICK_PER_IP ?? 6), `${starts} starts`);
  LA.close(); LB.close();
  // those matches went back to the day's budget, and other addresses play on
  const { A: FA, B: FB } = await pair('Free', 'Fair');
  FA.close(); FB.close();
  ok(`a leave and join loop from one address is stopped after ${starts} starts, and players from other addresses still get a match`);
}

// ---------- 9. a socket that takes no seat is closed (only with a short limit: JOIN_MS=2000 here and --var JOIN_MS:2000 on the dev server) ----------
if (process.env.JOIN_MS) {
  const JOIN = +process.env.JOIN_MS;
  const host = await client('S', '?new=1');
  host.send({ type: 'create', deck: DECK_A, name: 'Seated' });
  const { code: sc } = await host.next('room');
  const t2 = Date.now();
  const idle1 = await client('I1', '?new=1'), idle2 = await client('I2', `?room=${sc}`);
  // the room's close frame takes the socket out of the open state when the limit is up
  while ((idle1.ws.readyState === 1 || idle2.ws.readyState === 1) && Date.now() - t2 < JOIN + 5000) await sleep(50);
  const took = Date.now() - t2;
  assert.notEqual(idle1.ws.readyState, 1); assert.notEqual(idle2.ws.readyState, 1); assert.ok(took >= JOIN - 200, `closed after ${took} ms`);
  // the connection itself goes a little later (the dev server lets it go when the room has gone quiet)
  const [c1, c2] = await Promise.all([idle1.next('_close', () => true, 30000), idle2.next('_close', () => true, 30000)]);
  assert.equal(c1.code, 4002); assert.equal(c2.code, 4002);
  // the seated player is still there
  host.send({ type: 'ping', t: 9 });
  assert.deepEqual(await host.next('pong'), { type: 'pong', t: 9 });
  host.send({ type: 'leave' });
  host.close();
  ok(`a socket that never creates, joins or resumes is closed with 4002 (after ${took} ms); a seated player stays`);
}

console.log(`\nall ${passed} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(0);
