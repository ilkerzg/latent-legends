// Online play: one WebSocket to server/rooms.mjs, the room protocol (server/PROTOCOL.md), auto reconnect.
// The server is the authority. sendAction(a) only asks; apply an action when it comes back as an 'action'
// event (your own moves too), in order. net.js drops duplicates and resyncs on a gap, so every 'action'
// event is the next one to apply: reveal(s, m.r) (the cards it draws that this seat may see), then apply(s, m.a).
// A 'start' event resets the match: build it with newGame(db, m.deal, 0, { ...m.cfg, log: true, dealt: true,
// lanes: m.lanes }) and replay m.actions the same way (non empty after a resume). m.decks are both deck lists,
// sorted, for loading their art; the deck order and the opponent's hand never reach this screen.
// A socket belongs to one room and its address says which (?new=1 for a room about to be made, ?room=CODE):
// the Cloudflare server (cloudflare/worker.js) sends each socket to its room's own object; rooms.mjs ignores it.
const KEY = 'latent.room';
const PORT = 8787;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.+\.local)$/;
const THIS_MACHINE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const SHORT_MAX = 5;      // links in a row that the server closed straight after taking them before the client stops trying

const hasLoc = typeof location !== 'undefined';
// the deployed room server, used by every page that is not on this machine or the local network. Its address is not
// in the code: the site build writes it into the page as <meta name="rooms" content="wss://.../ws"> (tools/build_site.sh)
const deployedRooms = () => (typeof document !== 'undefined' && document.querySelector('meta[name="rooms"]')?.content) || null;
// whether this page can play online: a local page finds the local room server, a deployed one needs that address
export const onlineHere = () => !hasLoc || LOCAL_HOST.test(location.hostname) || !!deployedRooms();

// on a local page: the page's own origin when rooms.mjs serves it, else port 8787 (rooms.mjs or `npm run dev` in
// cloudflare/); a page opened on this machine itself also takes ?server=. Everywhere else only the deployed rooms: a
// link must never point a player at another server
export async function resolveUrl(explicit) {
  const q = hasLoc && THIS_MACHINE.test(location.hostname) ? new URLSearchParams(location.search).get('server') : null;
  if (explicit || q) return normalize(explicit || q);
  const secure = hasLoc && location.protocol === 'https:';
  const host = (hasLoc && location.hostname) || '127.0.0.1';
  if (hasLoc && !LOCAL_HOST.test(host)) {
    const rooms = deployedRooms();
    if (!rooms) throw new Error('Online play is not set up on this page.');
    return rooms;
  }
  if (hasLoc && /^https?:$/.test(location.protocol)) {
    try {
      const r = await fetch('/ws', { cache: 'no-store' });
      if (r.ok && (await r.json()).server === 'latent-legends-rooms') return `${secure ? 'wss' : 'ws'}://${location.host}/ws`;
    } catch {}
  }
  return `${secure ? 'wss' : 'ws'}://${host}:${PORT}/ws`;
}

function normalize(u) {
  const secure = hasLoc && location.protocol === 'https:';
  if (!/^[a-z]+:\/\//i.test(u)) u = `${secure ? 'wss' : 'ws'}://${u}`;
  const x = new URL(u);
  if (x.protocol === 'http:') x.protocol = 'ws:';
  if (x.protocol === 'https:') x.protocol = 'wss:';
  if (x.protocol !== 'ws:' && x.protocol !== 'wss:') throw new Error('not a room server address');
  if (x.pathname === '/' || x.pathname === '') x.pathname = '/ws';
  return x.href;
}

// retryMs: the first wait before a new try (each later one doubles, up to 10 s); stableMs: a link open this long has
// held, and the waits start over
export function createNet({ url, storage, pingMs = 20000, deadMs = 50000, retryMs = 500, stableMs = 5000 } = {}) {
  const store = storage !== undefined ? storage : (() => { try { return sessionStorage; } catch { return null; } })();
  // the seat kept between page loads: the room's code, this player's token and the room server that gave it out
  const saved = (() => { try { return JSON.parse(store?.getItem(KEY) || 'null'); } catch { return null; } })();
  const state = {
    status: 'idle',            // idle | connecting | open | reconnecting | closed
    url: null, code: saved?.code ?? null, token: saved?.token ?? null,
    inRoom: false, seat: null, players: [], names: null, match: 0,
    decks: null, deal: null, lanes: null, cfg: null, history: [], over: null, attempt: 0,
  };
  const handlers = new Map();
  let ws = null, want = false, retry = null, pinger = null, lastMsg = 0, resumeOnOpen = false, resyncing = false, outbox = [], waiting = [];
  let issuer = typeof saved?.url === 'string' ? saved.url : null, openedAt = 0, short = 0;
  // the room the next socket opens to (a code, 'new' or null), and the room of the socket open now
  let target = saved?.code ?? null, wsTarget = null;

  function emit(type, m) {
    for (const fn of [...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])]) {
      try { fn(m, type); } catch (e) { console.error(e); }
    }
  }
  const setStatus = (status, extra = {}) => { state.status = status; emit('status', { status, ...extra }); };
  const save = () => { issuer = state.url; try { store?.setItem(KEY, JSON.stringify({ code: state.code, token: state.token, url: state.url })); } catch {} };
  const forget = () => {
    try { store?.removeItem(KEY); } catch {}
    Object.assign(state, { code: null, token: null, inRoom: false, seat: null, players: [], match: 0, history: [], over: null });
    resumeOnOpen = false; resyncing = false; target = null;
  };
  const roomUrl = (t) => {
    const x = new URL(state.url);
    x.search = '';
    if (t === 'new') x.searchParams.set('new', '1');
    else if (t) x.searchParams.set('room', t);
    return x.href;
  };

  // point the socket at room t: a socket open to another room leaves it and closes, the next send opens the new one
  function aim(t) {
    target = t;
    if (!ws || wsTarget === t) return;
    const old = ws;
    ws = null; clearInterval(pinger);
    if (old.readyState === 1 && state.inRoom) old.send('{"type":"leave"}');
    old.close(1000);
    Object.assign(state, { inRoom: false, seat: null, players: [], history: [], over: null });
  }

  function send(m) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
    if (outbox.length < 50) outbox.push(m);
    connect();
    return false;
  }

  function connect() {
    want = true;
    if (ws && ws.readyState <= 1) return ws.readyState === 1 ? Promise.resolve() : new Promise((ok) => waiting.push(ok));
    if (!retry) open();
    return new Promise((ok) => waiting.push(ok));
  }

  async function open() {
    clearTimeout(retry); retry = null;
    setStatus(state.attempt ? 'reconnecting' : 'connecting');
    state.url ??= await resolveUrl(url);
    // a kept seat goes back only to the room server that gave it out: on any other address it is dropped unsent
    if (state.token && issuer !== state.url) {
      const stale = state.code;
      try { store?.removeItem(KEY); } catch {}
      Object.assign(state, { code: null, token: null });
      resumeOnOpen = false;
      if (target === stale) { target = null; if (!outbox.length) return stop(); }
    }
    if (!want || (ws && ws.readyState <= 1)) return;
    let sock;
    try { sock = ws = new WebSocket(roomUrl(target)); wsTarget = target; } catch (e) { ws = null; console.error(e); return schedule(); }
    sock.onopen = () => {
      if (ws !== sock) return;
      lastMsg = openedAt = Date.now();
      setStatus('open');
      clearInterval(pinger);
      pinger = setInterval(() => {
        if (ws !== sock) return clearInterval(pinger);
        if (Date.now() - lastMsg > deadMs) return sock.close(4001, 'no traffic');   // half open socket
        sock.send('{"type":"ping"}');
      }, pingMs);
      if (resumeOnOpen && state.code && state.token) sock.send(JSON.stringify({ type: 'resume', code: state.code, token: state.token }));
      resumeOnOpen = false;
      for (const m of outbox.splice(0)) sock.send(JSON.stringify(m));
      for (const ok of waiting.splice(0)) ok();
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastMsg = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m.type === 'string') handle(m);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      clearInterval(pinger);
      setStatus('closed', { code: e.code });
      // a link that held starts the waits over. One the server closed straight after taking it makes the next wait
      // longer, and after SHORT_MAX of those in a row the client stops: the server is not going to keep this seat
      const held = openedAt ? Date.now() - openedAt : -1;
      openedAt = 0;
      if (held >= stableMs) state.attempt = short = 0;
      else if (held >= 0) short++;
      // 4000: this seat was resumed somewhere else (another tab), do not fight over it
      if (e.code === 4000) { want = false; return; }
      if (want && short >= SHORT_MAX) { forget(); stop(); return emit('error', { reason: 'connection lost' }); }
      if (want) { resumeOnOpen = state.inRoom || resumeOnOpen; schedule(); }
    };
    sock.onerror = () => {};
  }

  function schedule() {
    if (!want || retry) return;
    const delay = Math.round(Math.min(10000, retryMs * 2 ** state.attempt) * (0.75 + Math.random() * 0.5));
    state.attempt++;
    setStatus('reconnecting', { attempt: state.attempt, delay });
    retry = setTimeout(() => { retry = null; open(); }, delay);
  }

  function handle(m) {
    switch (m.type) {
      case 'room':
        if (typeof m.code !== 'string' || !CODE_RE.test(m.code)) return;   // not a room code: ignore it
        Object.assign(state, { code: m.code, token: m.token, players: m.players, inRoom: true, match: m.match });
        if (m.seat != null) state.seat = m.seat;
        target = wsTarget = m.code;   // a new room has its code now; reconnects go straight to it
        save();
        break;
      case 'start':
        resyncing = false;
        Object.assign(state, {
          seat: m.seat, decks: m.decks, deal: m.deal, lanes: m.lanes, cfg: m.cfg, names: m.names, match: m.match,
          history: (m.actions ?? []).slice(), over: null, inRoom: true,
        });
        break;
      case 'action':
        if (resyncing || m.n < state.history.length) return;     // already have it, or a 'start' with everything is coming
        if (m.n > state.history.length) { resyncing = resume(); return; }   // missed some: the resume's 'start' resends all
        state.history.push({ a: m.a, r: m.r });
        break;
      case 'over': state.over = { winner: m.winner, reason: m.reason }; break;
      case 'error':
        // the room is gone, or online play is full for today: no room left to keep a socket open for
        if (m.reason === 'unknown room' || m.reason === 'room expired' || m.reason === 'busy') { forget(); stop(); }
        break;
    }
    emit(m.type, m);
  }

  function resume() {
    if (!state.code || !state.token) return false;
    aim(state.code);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resume', code: state.code, token: state.token }));
    else { resumeOnOpen = true; connect(); }
    return true;
  }

  // stop for good: no reconnect, the seat stays held on the server until the grace runs out
  function stop() { want = false; clearTimeout(retry); retry = null; clearInterval(pinger); outbox = []; if (ws) { const s = ws; ws = null; s.close(1000); } setStatus('idle'); }

  return {
    state,
    connect,
    createRoom: (deck, name) => { aim('new'); return send({ type: 'create', deck, name }); },
    joinRoom: (code, deck, name) => { const c = String(code).trim().toUpperCase(); aim(c); return send({ type: 'join', code: c, deck, name }); },
    // n: actions applied so far; defaults to the count received from the server
    sendAction: (a, n = state.history.length) => send({ type: 'action', a, n }),
    resume,
    rematch: (deck) => send(deck ? { type: 'rematch', deck } : { type: 'rematch' }),
    leave: () => { if (ws && ws.readyState === 1) ws.send('{"type":"leave"}'); forget(); stop(); },
    close: stop,
    on: (type, fn) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type)?.delete(fn); },
    off: (type, fn) => handlers.get(type)?.delete(fn),
  };
}
