// Latent Legends room server on Cloudflare: the Worker sends each WebSocket to one Durable Object per room.
// Same protocol and rules as server/rooms.mjs (server/PROTOCOL.md), with one difference: a socket picks its room
// when it opens, /ws?new=1 for a room about to be created, /ws?room=CODE to join or resume. web/net.js does this.
// A room keeps its match in storage and sleeps between messages (WebSocket hibernation), so a quiet room costs nothing.
// Each seat sees only what it may (engine/hidden.js): the room keeps the order the decks were dealt in and both hands.
// A daily budget (class Budget) caps what the rooms can cost: every socket and every match start takes one from today's
// count, overall and per address, and past the caps (wrangler.toml [vars]) players get 'busy' instead. A socket may
// send MSGS_PER_SOCKET messages, so the day's messages have a ceiling too. No address gets more than a share of the
// matches left today, and matches dropped as soon as they start are given back and counted against whoever dropped
// them, so a few addresses can not use the day up for everyone.
//   npm run dev      (ws://127.0.0.1:8787/ws, the same address the game tries on localhost)
//   npm run deploy
import { DurableObject } from 'cloudflare:workers';
import { indexCards, legalActions } from '../engine/rules.js';
import { validateDeck } from '../engine/deck.js';
import { deal, redeal, play, seen, dealtFor, listOf } from '../engine/hidden.js';
import { actionShape, cleanName, sameToken, pingT, ipKey } from '../server/guard.mjs';
import cards from '../data/cards.json';

const db = indexCards(cards.cards);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1
const CODE_RE = new RegExp(`^[${ALPHABET}]{5}$`);
const NOWHERE = '-';         // the room for malformed codes and plain /ws: it never holds a match, so it answers 'unknown room'
const IDLE_MS = 600_000;     // a room with no traffic for this long is closed
const CHECK_MS = 60_000;     // while a match runs, the room wakes this often to drop sockets that went silent
const DEAD_MS = 90_000;      // the client pings every 20 s (a hidden tab's timers may slow to once a minute); silent this long is gone
const SAVE_MS = 1000;        // room writes are batched: at most one per second
const MAX_MSG = 16 * 1024;
const RATE = { burst: 120, perSec: 60 };   // token bucket per socket, generous: auto combat can send a burst
const PING = '{"type":"ping"}';
const AFK_TURNS = 3;         // a player who runs out of time this many turns in a row loses
const STRIKES = 60;          // messages past the rate limit before the socket is closed
// the messages that change a room; each can cost a storage write, so one socket may send only SEAT_REQS of them
const SEAT_TYPES = new Set(['create', 'join', 'resume', 'rematch', 'leave']);
const SEAT_REQS = 100;
const VERSION = 3;           // the stored room's shape; an older room is closed when it wakes
const QUICK_MS = 45_000;     // a match over sooner than this after its start was not played (see finish)
const SHARE = 20;            // an address may hold one part in this many of the matches left today,
const SHARE_MIN = 10;        // but its allowance never falls below this many matches a day
const BYTES = new TextEncoder();

// stable JSON (sorted keys), used to compare actions
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
// a whole number from 0 to n - 1 from the cryptographic generator, each equally likely (values past the last full
// multiple of n are drawn again)
function randomInt(n) {
  const limit = 2 ** 32 - (2 ** 32 % n), word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return word[0] % n;
}
const newCode = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// today's budget object (one per UTC day, so the counts start over at midnight UTC)
const budget = (env) => env.BUDGET.get(env.BUDGET.idFromName(new Date().toISOString().slice(0, 10)));
// An address the budget has just refused (everyone, under '', when the day's sockets are gone) is refused again for a
// while without asking: a flood of sockets then costs one request each and never reaches the budget object.
const REFUSE_MS = { day: 30_000, address: 10_000 };
const refused = new Map();   // address -> refused until; kept in this isolate's memory only

// a refusal goes over a socket that closes at once: an HTTP error would only make the client try again and again
function refuse(reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ type: 'error', reason }));
  server.close(1000, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/ws' && url.pathname !== '/healthz') return new Response('Not found\n', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return Response.json({ server: 'latent-legends-rooms', ok: true, rooms: 'durable-objects' }, { headers: { 'Cache-Control': 'no-store' } });
    // only the game's own pages may open sockets (a missing Origin is a non-browser client, which could send any Origin anyway)
    const origin = req.headers.get('Origin');
    if (origin && !LOCAL.test(origin) && !(env.ORIGINS ?? '').split(',').map((s) => s.trim()).includes(origin))
      return new Response('Forbidden\n', { status: 403 });
    const ip = ipKey(req.headers.get('CF-Connecting-IP') ?? ''), now = Date.now();
    if ((refused.get('') ?? 0) > now || (refused.get(ip) ?? 0) > now) return refuse('busy');
    const fits = await budget(env).take('socket', [ip]);
    if (fits !== 'ok') {
      if (refused.size > 10_000) refused.clear();
      refused.set(fits === 'day' ? '' : ip, now + REFUSE_MS[fits]);
      return refuse('busy');
    }
    const room = (code, fresh) => {
      // the room trusts these headers, so none of them may come from the client
      const headers = new Headers(req.headers);
      for (const h of ['X-Room-Code', 'X-Room-New', 'X-Client-Key']) headers.delete(h);
      headers.set('X-Room-Code', code);
      headers.set('X-Client-Key', ip);
      if (fresh) headers.set('X-Room-New', '1');
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(req.url, { headers }));
    };
    if (url.searchParams.get('new') === '1') {
      // a random code; the room answers 409 if that code is taken, then another one is drawn
      for (let i = 0; i < 8; i++) {
        const res = await room(newCode(), true);
        if (res.status !== 409) return res;
      }
      return refuse('server full');
    }
    const code = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    return room(CODE_RE.test(code) ? code : NOWHERE, false);
  },
};

// One room. this.room is all of it that lasts: it is saved to storage, and the engine state is rebuilt from the
// dealt decks and the history when the object wakes up. Players are known by their token; a socket carries its player's
// token in its attachment, so the link between sockets and seats survives hibernation too.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.graceMs = +(env.GRACE_MS ?? 60_000);   // a dropped player gets this long to resume before the opponent wins by forfeit
    this.turnMs = +(env.TURN_MS ?? 75_000);     // a turn's clock: about 60 s to decide plus the time the previous turn takes to play out
    this.joinMs = +(env.JOIN_MS ?? 30_000);     // a socket has this long to take a seat (create, join or resume) before it is closed
    this.room = null; this.s = null; this.saving = null; this.reserved = false; this.gone = new WeakSet();
    // pings are answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, '{"type":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) ?? null;
      // a room stored in an older shape can not be played on: its players are told it closed
      if (this.room && this.room.v !== VERSION) {
        for (const ws of ctx.getWebSockets()) { this.send(ws, 'error', { reason: 'room expired' }); try { ws.close(1000, 'room expired'); } catch {} }
        this.room = null;
        await ctx.storage.deleteAlarm();
        await ctx.storage.deleteAll();
      }
    });
  }

  async fetch(req) {
    const code = req.headers.get('X-Room-Code'), fresh = req.headers.get('X-Room-New') === '1';
    if (fresh && (this.room || this.reserved)) return new Response(null, { status: 409 });
    if (fresh) this.reserved = true;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment({ code, fresh, ip: req.headers.get('X-Client-Key') ?? '', token: null, name: 'Player', tokens: RATE.burst, at: now, since: now, strikes: 0, warned: 0, msgs: 0, reqs: 0 });
    // the alarm closes a socket that has not taken a seat joinMs from now
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > now + this.joinMs) await this.ctx.storage.setAlarm(now + this.joinMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- sockets and players ----------

  send(ws, type, m = {}) { try { ws?.send(JSON.stringify({ type, ...m })); } catch {} }
  sockets(p) {
    return this.ctx.getWebSockets().filter((ws) => !this.gone.has(ws) && ws.readyState === 1 && ws.deserializeAttachment()?.token === p.token);
  }
  sock(p) { return this.sockets(p)[0] ?? null; }
  player(token) { return token ? this.room?.players.find((x) => x.token === token) ?? null : null; }
  other(p) { return this.room.players.find((q) => q !== p) ?? null; }
  started() { return !!this.room?.order; }
  live() { return this.started() && !this.room.over; }
  // the active player's time left this turn (null without a clock: no match, or a stored room with no turnAt)
  left() { return this.live() && this.room.turnAt ? Math.max(0, this.room.turnAt - Date.now()) : null; }
  // the engine state, rebuilt from the dealt decks and every accepted action after the room slept
  game() {
    const r = this.room;
    if (!this.s && r?.order) {
      this.dealt = redeal(db, r.order, r.lanes, {});
      this.s = this.dealt.s;
      for (const h of r.history) play(this.s, h.a);
    }
    return this.s;
  }
  roomMsg(p) {
    const r = this.room;
    return {
      code: r.code, seat: p.seat, token: p.token, match: r.match,
      players: r.players.map((q) => ({ name: q.name, seat: q.seat, online: !!this.sock(q), rematch: q.rematch })),
    };
  }
  announce() { for (const p of this.room.players) this.send(this.sock(p), 'room', this.roomMsg(p)); }
  // the match as seat p sees it: the deck lists without their order, its own opening hand and every action with the
  // cards it drew; the order the decks were dealt in stays in the room
  startMsg(p) {
    const r = this.room, s = this.game();
    return {
      decks: r.order.map(listOf), deal: dealtFor(this.dealt, p.seat), lanes: s.terrain, seat: p.seat, cfg: s.cfg, match: r.match,
      names: r.seats.map((t) => this.player(t)?.name ?? 'Player'), actions: r.history.map((h) => ({ a: h.a, r: seen(h.d, p.seat) })),
      left: this.left(), turnMs: this.turnMs,
    };
  }

  // writes are batched (one per SAVE_MS); a pending timer also keeps the room awake until the write is done
  save(now = false) {
    if (now) { clearTimeout(this.saving); this.saving = null; return this.flush(); }
    this.saving ??= setTimeout(() => { this.saving = null; this.flush(); }, SAVE_MS);
  }
  async flush() {
    if (!this.room) return;
    await this.ctx.storage.put('room', this.room);
    await this.arm();
  }
  // one alarm covers the idle timeout, the grace periods and, during a match, the silent socket check
  async arm() {
    const r = this.room;
    if (!r) return;
    let at = r.last + IDLE_MS;
    for (const p of r.players) if (p.graceUntil) at = Math.min(at, p.graceUntil);
    for (const ws of this.ctx.getWebSockets()) { const c = ws.deserializeAttachment(); if (!c?.token && !this.gone.has(ws)) at = Math.min(at, c.since + this.joinMs); }
    if (this.live()) at = Math.min(at, Date.now() + CHECK_MS, r.turnAt ?? Infinity);
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at || cur < Date.now()) await this.ctx.storage.setAlarm(at);
  }
  async wipe() {
    clearTimeout(this.saving); this.saving = null;
    this.room = null; this.s = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  checkDeck(ws, deck) {
    if (!Array.isArray(deck) || deck.length > 60 || deck.some((x) => typeof x !== 'string')) { this.send(ws, 'error', { reason: 'bad deck: No deck' }); return null; }
    const v = validateDeck(db, deck);
    if (!v.ok) { this.send(ws, 'error', { reason: `bad deck: ${v.errors.join('; ')}` }); return null; }
    return deck.slice();
  }

  // ---------- matches ----------

  // the players' addresses, each once: a match is charged to every address in it
  ips() { return [...new Set(this.room.players.map((p) => this.sock(p)?.deserializeAttachment()?.ip ?? ''))]; }
  // a match takes one from today's budget, overall and for each player's address. The room may change while the
  // budget answers, so it is checked before and after, and a match that does not start after all is given back
  async startMatch(swap) {
    const ready = () => {
      const r = this.room;
      return r && r.players.length === 2 && r.players.every((x) => this.sock(x)) && !this.live() && (!swap || r.players.every((x) => x.rematch));
    };
    if (this.starting || !ready()) return;
    this.starting = true;
    const ips = this.ips();
    let ok = false;
    try { ok = (await budget(this.env).take('match', ips)) === 'ok'; } catch (e) { console.error('budget', e); } finally { this.starting = false; }
    const r = this.room;
    if (!ready()) { if (ok) budget(this.env).give('match', ips).catch(() => {}); return; }
    if (!ok) {
      for (const p of r.players) { p.rematch = false; this.send(this.sock(p), 'error', { reason: 'busy' }); }
      return this.save(true);
    }
    const [a, b] = r.players;
    r.seats = swap && r.seats ? [r.seats[1], r.seats[0]] : randomInt(2) ? [b.token, a.token] : [a.token, b.token];
    r.seats.forEach((t, i) => { const p = this.player(t); p.seat = i; p.rematch = false; });
    // dealt with the cryptographic generator, so no player can work the order out; the room stores that order
    this.dealt = deal(db, r.seats.map((t) => this.player(t).deck), randomInt, {});
    this.s = this.dealt.s;
    r.order = this.dealt.dealt; r.lanes = this.dealt.lanes;
    r.history = [];
    r.over = null;
    r.match++;
    r.startedAt = Date.now();
    r.turnAt = r.startedAt + this.turnMs;
    r.afk = [0, 0];
    for (const p of r.players) { const ws = this.sock(p); this.send(ws, 'room', this.roomMsg(p)); this.send(ws, 'start', this.startMsg(p)); }
    this.save(true);
  }

  // A match over within QUICK_MS of its start was not played: it goes back to the day's budget, and the addresses that
  // ended it are marked (by: the one that left, nobody after a forfeit; else everyone in the room). An address with too
  // many marks starts no more matches today (Budget.quick), so starting matches only to drop them does not use the day up.
  finish(winner, reason, by = null) {
    const r = this.room;
    if (reason !== 'error' && r.startedAt && Date.now() - r.startedAt < QUICK_MS)
      this.ctx.waitUntil(budget(this.env).quick(by ?? this.ips()).catch((e) => console.error('budget', e)));
    r.startedAt = 0;
    r.over = { winner, reason };
    for (const p of r.players) { p.graceUntil = 0; p.rematch = false; this.send(this.sock(p), 'over', r.over); }
    this.save(true);
  }

  // the socket dropped: the seat is held for graceMs while a match is running
  dropped(ws) {
    if (this.gone.has(ws)) return;   // already handled (the alarm closed it, or a resume replaced it)
    this.gone.add(ws);
    const c = ws.deserializeAttachment(), p = this.player(c?.token);
    if (!p || this.sock(p)) return;   // not seated, or the player is still here on another socket
    const r = this.room, q = this.other(p);
    r.last = Date.now();
    if (this.live()) {
      p.graceUntil = Date.now() + this.graceMs;
      if (q) this.send(this.sock(q), 'opponent_left', { graceMs: this.graceMs });
    } else if (q) this.send(this.sock(q), 'opponent_left', { graceMs: 0 });
    if (q) this.send(this.sock(q), 'room', this.roomMsg(q));
    this.save(true);
  }

  async leave(ws) {
    const c = ws.deserializeAttachment(), p = this.player(c.token);
    if (!p) return;
    c.token = null; c.since = Date.now(); ws.serializeAttachment(c);
    const r = this.room, q = this.other(p);
    if (this.live() && q && p.seat !== null) this.finish(1 - p.seat, 'left', [c.ip]);
    r.players = r.players.filter((x) => x !== p);
    if (!r.players.length) return this.wipe();
    // the one who stays keeps the room, a new opponent can join with the same code; the match that was played is gone
    Object.assign(r, { seats: null, order: null, lanes: null, history: [], over: null, turnAt: 0, startedAt: 0 });
    this.s = this.dealt = null;
    for (const x of r.players) { x.seat = null; x.rematch = false; }
    this.send(this.sock(q), 'opponent_left', { graceMs: 0 });
    this.announce();
    this.save(true);
  }

  join(ws, c, deck, name) {
    const r = this.room;
    const p = { name: cleanName(name, c.name), token: newToken(), deck, seat: null, rematch: false, graceUntil: 0 };
    r.players.push(p);
    c.token = p.token; ws.serializeAttachment(c);
    r.last = Date.now();
    if (r.players.length === 2 && r.players.every((x) => this.sock(x))) return this.startMatch(false);
    this.announce();
    this.save(true);
  }

  onAction(ws, p, m) {
    const r = this.room;
    if (!r || !p) return this.send(ws, 'error', { reason: 'not in a room' });
    if (!this.started()) return this.send(ws, 'reject', { reason: 'no match' });
    if (r.over) return this.send(ws, 'reject', { reason: 'game over' });
    const s = this.game();
    if (p.seat !== s.active) return this.send(ws, 'reject', { reason: 'not your turn', n: r.history.length });
    if (m.n !== r.history.length) return this.send(ws, 'reject', { reason: 'stale', n: r.history.length });
    if (!actionShape(m.a)) return this.send(ws, 'reject', { reason: 'illegal action', n: r.history.length });
    const want = stable(m.a);
    const a = legalActions(s).find((x) => stable(x) === want);
    if (!a) return this.send(ws, 'reject', { reason: 'illegal action', n: r.history.length });
    (r.afk ??= [0, 0])[p.seat] = 0;
    if (this.commit(a, p.seat)) this.save();
  }

  // apply one accepted action and tell both players; when the turn passes, the next player's clock starts.
  // false when the match ended (or the engine failed)
  commit(a, seat, auto = false) {
    const r = this.room, s = this.game(), n = r.history.length;
    let d;
    try { d = play(s, a); }
    catch (e) { console.error(`room ${r.code} engine error`, e); this.s = null; this.finish(null, 'error'); return false; }
    r.history.push({ a, d });
    // each seat gets the cards it drew with the action that drew them
    const tell = (extra) => { for (const q of r.players) this.send(this.sock(q), 'action', { a, n, seat, r: seen(d, q.seat), ...(auto && { auto }), ...extra }); };
    if (s.phase === 'over') {
      tell({});
      this.finish(s.winner, s.endReason);
      return false;
    }
    if (s.active !== seat) r.turnAt = Date.now() + this.turnMs;
    tell({ left: this.left() });
    return true;
  }

  // the active player's clock ran out: the room plays the rest of the turn for them (the main phase ends, then
  // every unit attacks); running out AFK_TURNS turns in a row loses the match
  timeUp() {
    const r = this.room, s = this.game(), seat = s.active;
    const afk = (r.afk ??= [0, 0]);
    if (++afk[seat] >= AFK_TURNS) return this.finish(1 - seat, 'timeout');
    for (let i = 0; i < 64 && s.phase !== 'over' && s.active === seat; i++) {
      const a = s.phase === 'main' ? { t: 'end' } : { t: 'act', mode: 'attack' };
      if (!legalActions(s).some((x) => stable(x) === stable(a))) break;
      if (!this.commit(a, seat, true)) return;
    }
    if (this.live() && s.active === seat) r.turnAt = Date.now() + this.turnMs;   // nothing to play: try again next round
  }

  // a wrong code and a wrong token get the same answer, so a resume does not tell whether a room is open
  onResume(ws, c, m) {
    const r = this.room;
    const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
    const p = r && code === r.code ? r.players.find((x) => sameToken(m.token, x.token)) : null;
    if (!p) return this.send(ws, 'error', { reason: 'unknown room' });
    // a resume from a second tab takes the seat; the old socket is closed with 4000
    for (const old of this.sockets(p)) {
      if (old === ws) continue;
      const oc = old.deserializeAttachment(); oc.token = null; old.serializeAttachment(oc);
      this.gone.add(old);
      try { old.close(4000, 'replaced'); } catch {}
    }
    const wasAway = !this.sock(p);
    p.graceUntil = 0;
    c.token = p.token; ws.serializeAttachment(c);
    r.last = Date.now();
    const q = this.other(p);
    if (!this.started() && r.players.length === 2 && r.players.every((x) => this.sock(x))) return this.startMatch(false);
    this.send(ws, 'room', this.roomMsg(p));
    if (this.started()) this.send(ws, 'start', this.startMsg(p));
    if (r.over) this.send(ws, 'over', r.over);
    if (q && !this.sock(q)) this.send(ws, 'opponent_left', { graceMs: q.graceUntil ? Math.max(0, q.graceUntil - Date.now()) : 0 });
    if (q && wasAway) { const qs = this.sock(q); this.send(qs, 'opponent_back'); this.send(qs, 'room', this.roomMsg(q)); }
    this.save(true);
  }

  onRematch(ws, p, m) {
    const r = this.room;
    if (!r || !p) return this.send(ws, 'error', { reason: 'not in a room' });
    if (r.players.length < 2) return this.send(ws, 'error', { reason: 'no opponent' });
    if (!this.started() || !r.over) return this.send(ws, 'error', { reason: 'no finished match' });
    if (m.deck !== undefined) { const d = this.checkDeck(ws, m.deck); if (!d) return; p.deck = d; }
    p.rematch = true;
    if (r.players.every((x) => x.rematch && this.sock(x))) return this.startMatch(true);
    this.announce();
    this.save(true);
  }

  // ---------- hibernation handlers ----------

  // a message that makes a handler throw costs that socket, never the room
  async webSocketMessage(ws, text) {
    try { await this.onMessage(ws, text); }
    catch (e) { console.error(`room ${this.room?.code ?? '-'} message error`, e); try { ws.close(1011, 'server error'); } catch {} }
  }

  async onMessage(ws, text) {
    // a socket the room has closed may still send until its own side closes: nothing more is read from it
    if (ws.readyState !== 1) return;
    // text only, and at most MAX_MSG bytes (a character is one to three bytes of UTF-8)
    if (typeof text !== 'string') return ws.close(1003, 'text only');
    if (text.length > MAX_MSG || (text.length * 3 > MAX_MSG && BYTES.encode(text).length > MAX_MSG)) return ws.close(1009, 'message too big');
    const c = ws.deserializeAttachment();
    // a socket's messages have a ceiling, so the day's bill has one too (DAILY_SOCKETS times MSGS_PER_SOCKET)
    if (++c.msgs > +(this.env.MSGS_PER_SOCKET ?? 4000)) { ws.serializeAttachment(c); return ws.close(1008, 'message limit'); }
    // token bucket: refills perSec per second up to burst; past the limit messages are dropped
    const now = Date.now();
    c.tokens = Math.min(RATE.burst, c.tokens + ((now - c.at) / 1000) * RATE.perSec);
    c.at = now;
    if (c.tokens < 1) {
      if (++c.strikes > STRIKES) { ws.serializeAttachment(c); return ws.close(1008, 'rate limit'); }
      if (now - c.warned > 1000) { c.warned = now; this.send(ws, 'error', { reason: 'rate limit' }); }
      return ws.serializeAttachment(c);
    }
    c.tokens--;
    ws.serializeAttachment(c);
    let m;
    try { m = JSON.parse(text); } catch { return this.send(ws, 'error', { reason: 'bad json' }); }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return this.send(ws, 'error', { reason: 'bad message' });
    if (SEAT_TYPES.has(m.type)) {
      c.reqs = (c.reqs ?? 0) + 1;
      ws.serializeAttachment(c);
      if (c.reqs > SEAT_REQS) return ws.close(1008, 'request limit');
    }
    const p = this.player(c.token);
    if (p) this.room.last = now;
    switch (m.type) {
      case 'ping': return this.send(ws, 'pong', pingT(m.t));
      case 'hello': c.name = cleanName(m.name, c.name); return ws.serializeAttachment(c);
      case 'create': {
        if (!c.fresh) return this.send(ws, 'error', { reason: 'open /ws?new=1 to create a room' });
        if (this.room) return this.send(ws, 'error', { reason: 'already in a room' });
        const deck = this.checkDeck(ws, m.deck);
        if (!deck) return;
        this.room = { v: VERSION, code: c.code, players: [], seats: null, order: null, lanes: null, history: [], over: null, match: 0, last: now };
        console.log(`room ${c.code} created`);
        return this.join(ws, c, deck, m.name);
      }
      case 'join': {
        // the deck first, so a bad deck says the same about every code
        const deck = this.checkDeck(ws, m.deck);
        if (!deck) return;
        const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
        if (!this.room || code !== this.room.code) return this.send(ws, 'error', { reason: 'unknown room' });
        if (p) return this.send(ws, 'error', { reason: 'already in this room' });
        if (this.room.players.length >= 2) return this.send(ws, 'error', { reason: 'room full' });
        return this.join(ws, c, deck, m.name);
      }
      case 'action': return this.onAction(ws, p, m);
      case 'resume': return this.onResume(ws, c, m);
      case 'rematch': return this.onRematch(ws, p, m);
      case 'leave': return this.leave(ws);
      default: return;   // unknown types are ignored
    }
  }

  async webSocketClose(ws, code) {
    this.closed(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) { this.closed(ws); }

  closed(ws) {
    if (this.room) return this.dropped(ws);
    // the socket that was going to create this room went away first: the code is free again
    this.gone.add(ws);
    this.reserved = this.ctx.getWebSockets().some((x) => !this.gone.has(x) && x.deserializeAttachment()?.fresh);
  }

  async alarm() {
    const now = Date.now();
    // sockets that never took a seat are closed; one still inside its joinMs brings the alarm back
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const c = ws.deserializeAttachment();
      if (c?.token || this.gone.has(ws)) continue;
      if (now - c.since < this.joinMs) { next = Math.min(next, c.since + this.joinMs); continue; }
      try { ws.close(4002, 'no seat'); } catch {}
      this.closed(ws);
    }
    const r = this.room;
    if (!r) { if (next < Infinity) await this.ctx.storage.setAlarm(next); return; }
    if (now - r.last >= IDLE_MS) {
      for (const ws of this.ctx.getWebSockets()) { this.send(ws, 'error', { reason: 'room expired' }); try { ws.close(1000, 'room expired'); } catch {} }
      console.log(`room ${r.code} expired`);
      return this.wipe();
    }
    // half open sockets (a phone that went to sleep) never send a close: silent for DEAD_MS means gone
    for (const ws of this.ctx.getWebSockets()) {
      const c = ws.deserializeAttachment();
      const seen = Math.max(c.at, c.since, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if (now - seen > DEAD_MS) { try { ws.close(4001, 'no traffic'); } catch {} this.dropped(ws); }
    }
    for (const p of r.players) {
      if (!p.graceUntil || now < p.graceUntil || this.sock(p)) continue;
      p.graceUntil = 0;
      if (this.live()) this.finish(1 - p.seat, 'forfeit', []);
    }
    if (this.live() && r.turnAt && now >= r.turnAt) this.timeUp();
    await this.save(true);
  }
}

// Today's counts, one object per UTC day. Sockets and match starts each take one, overall and per address; past a cap
// the answer is no, so the bill has a ceiling whatever happens (a crowd, a bug, someone opening sockets in a loop).
// Addresses are kept only as a hash with this day's own salt, so the counts can not be tied to an address or to
// another day. The object deletes itself two days later.
export class Budget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.recent = new Map();   // address hash -> socket times this minute (in memory: a short window needs no storage)
    ctx.blockConcurrencyWhile(async () => {
      this.counts = (await ctx.storage.get('counts')) ?? { socket: 0, match: 0 };
      this.salt = (await ctx.storage.get('salt')) ?? crypto.randomUUID();
      await ctx.storage.put('salt', this.salt);
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 2 * 86_400_000);
    });
  }

  async hash(ip) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${ip}`));
    return btoa(String.fromCharCode(...new Uint8Array(d).slice(0, 12)));
  }

  // 'ok' when one more socket or match fits in today's caps, overall and for every address given; else the cap that
  // said no: 'day' (the whole day's count) or 'address'
  async take(kind, ips = []) {
    const env = this.env;
    const cap = kind === 'match' ? +(env.DAILY_MATCHES ?? 1500) : +(env.DAILY_SOCKETS ?? 20000);
    let perIp = kind === 'match' ? +(env.MATCHES_PER_IP ?? 120) : +(env.SOCKETS_PER_IP ?? 200);
    if (this.counts[kind] >= cap) return 'day';
    // matches: no address holds more than its share of what is left of the day, so the fewer are left, the more
    // addresses it takes to use them up
    if (kind === 'match') perIp = Math.min(perIp, Math.max(SHARE_MIN, Math.ceil((cap - this.counts.match) / SHARE)));
    const hashes = await Promise.all(ips.filter(Boolean).map((ip) => this.hash(ip)));
    const keys = hashes.map((h) => `${kind}:${h}`), marks = kind === 'match' ? hashes.map((h) => `quick:${h}`) : [];
    const had = await this.ctx.storage.get([...keys, ...marks]);
    if (keys.some((k) => (had.get(k) ?? 0) >= perIp)) return 'address';
    if (marks.some((k) => (had.get(k) ?? 0) >= +(env.QUICK_PER_IP ?? 6))) return 'address';
    if (kind === 'socket') {
      // and no more than a few a second from one address
      const now = Date.now(), perMin = +(env.SOCKETS_PER_IP_MIN ?? 40);
      for (const k of keys) {
        const times = (this.recent.get(k) ?? []).filter((t) => now - t < 60_000);
        if (times.length >= perMin) return 'address';
        this.recent.set(k, [...times, now]);
      }
      if (this.recent.size > 50_000) this.recent.clear();
    }
    this.counts[kind]++;
    const put = { counts: this.counts };
    for (const k of keys) put[k] = (had.get(k) ?? 0) + 1;
    await this.ctx.storage.put(put);
    return 'ok';
  }

  // a match that was charged but did not start after all
  async give(kind, ips = []) {
    const keys = await Promise.all(ips.filter(Boolean).map(async (ip) => `${kind}:${await this.hash(ip)}`));
    const had = await this.ctx.storage.get(keys);
    this.counts[kind] = Math.max(0, this.counts[kind] - 1);
    const put = { counts: this.counts };
    for (const k of keys) put[k] = Math.max(0, (had.get(k) ?? 1) - 1);
    await this.ctx.storage.put(put);
  }

  // a match that ended almost as soon as it started: it goes back to the day's count, and each address that ended it
  // gets a mark. take() refuses an address with QUICK_PER_IP marks, and the address's own count of matches stays
  async quick(ips = []) {
    const keys = await Promise.all(ips.filter(Boolean).map(async (ip) => `quick:${await this.hash(ip)}`));
    const had = await this.ctx.storage.get(keys);
    this.counts.match = Math.max(0, this.counts.match - 1);
    const put = { counts: this.counts };
    for (const k of keys) put[k] = (had.get(k) ?? 0) + 1;
    await this.ctx.storage.put(put);
  }

  async alarm() { await this.ctx.storage.deleteAll(); }
}
