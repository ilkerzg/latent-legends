// Data for the public balance page (web/balance.html): the starter decks (engine/deck.js) in every ordered pair, the same
// bot in both seats, on all CPU cores.
// node sim/balance_page.mjs [games per ordered deck pair] [bot] [--seed=1]
// Writes web/data/balance_<bot>.json: deck win rates, the deck against deck table, first player edge, game length,
// how games end, and for every card how often it was played and how often the player who played it won.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { STARTERS } from '../engine/deck.js';
import { newGame, apply } from '../engine/rules.js';
import { loadDb } from './game.js';
import { BOTS } from './bots/greedy.js';

if (isMainThread) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const n = Number(pos[0] || 50);
  const bot = pos[1] || 'greedy';
  const seed0 = Number(args.find((a) => a.startsWith('--seed='))?.split('=')[1] || 1);
  const keys = Object.keys(STARTERS);
  const jobs = [];
  let seed = seed0;
  for (const a of keys) for (const b of keys) for (let g = 0; g < n; g++) jobs.push([a, b, seed++]);
  const workers = Math.max(1, cpus().length - 2);
  const chunks = Array.from({ length: workers }, (_, w) => jobs.filter((_, i) => i % workers === w));
  const t0 = Date.now();
  const res = (await Promise.all(chunks.map((chunk) => new Promise((ok, fail) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { chunk, bot } });
    w.on('message', ok);
    w.on('error', fail);
  })))).flat();

  const N = res.length;
  const decisive = res.filter((g) => g.w !== 'draw');
  // a deck's score: wins plus half the draws, over its games (mirror games count once for each side)
  const deck = Object.fromEntries(keys.map((k) => [k, { games: 0, score: 0 }]));
  const vs = Object.fromEntries(keys.map((k) => [k, Object.fromEntries(keys.map((j) => [j, { games: 0, score: 0 }]))]));
  const cards = {};
  const reasons = {};
  for (const g of res) {
    reasons[g.r] = (reasons[g.r] || 0) + 1;
    const seats = [g.a, g.b];
    for (const p of [0, 1]) {
      const pts = g.w === 'draw' ? 0.5 : g.w === p ? 1 : 0;
      deck[seats[p]].games++; deck[seats[p]].score += pts;
      if (g.a !== g.b) { vs[seats[p]][seats[1 - p]].games++; vs[seats[p]][seats[1 - p]].score += pts; }
      for (const id of g.played[p]) {
        const c = (cards[id] ??= { played: 0, score: 0 });
        c.played++; c.score += pts;
      }
    }
  }
  const out = {
    bot, games: N, gamesPerPair: n, made: new Date().toISOString().slice(0, 10), secs: (Date.now() - t0) / 1000,
    decks: keys.map((k) => ({ key: k, name: STARTERS[k].name, games: deck[k].games, win: deck[k].score / deck[k].games })),
    vs: Object.fromEntries(keys.map((a) => [a, Object.fromEntries(keys.filter((b) => b !== a).map((b) => [b, vs[a][b].score / vs[a][b].games]))])),
    firstPlayerWin: decisive.filter((g) => g.w === 0).length / decisive.length,
    draws: (N - decisive.length) / N,
    rounds: res.reduce((x, g) => x + Math.ceil(g.t / 2), 0) / N,
    ends: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, v / N])),
    cards: Object.entries(cards).map(([id, c]) => ({ id, played: c.played, win: c.score / c.played })).sort((x, y) => y.played - x.played),
  };
  mkdirSync(new URL('../web/data/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../web/data/balance_${bot}.json`, import.meta.url), JSON.stringify(out, null, 1));
  console.log(`${N} games, ${bot} in both seats, ${out.secs.toFixed(1)} s on ${workers} workers`);
  for (const d of [...out.decks].sort((x, y) => y.win - x.win)) console.log(`${d.name.padEnd(14)} ${(d.win * 100).toFixed(1)}%`);
  console.log(`first player ${(out.firstPlayerWin * 100).toFixed(1)}% of decisive games, draws ${(out.draws * 100).toFixed(1)}%, ${out.rounds.toFixed(1)} rounds`);
} else {
  const { chunk, bot } = workerData;
  const db = loadDb();
  const out = [];
  for (const [a, b, seed] of chunk) {
    const s = newGame(db, [STARTERS[a].cards, STARTERS[b].cards], seed, { log: true });
    const holder = { rng: (seed * 7919) >>> 0 || 1 };
    const rnd = () => { let t = (holder.rng = (holder.rng + 0x6d2b79f5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let guard = 0;
    while (s.phase !== 'over') {
      apply(s, BOTS[bot](s, rnd));
      if (++guard > 5000) throw new Error('runaway game');
    }
    // the cards each seat put on the table (a Mimic copy is the Mimic joker's doing, not a play of the copied card)
    const played = [new Set(), new Set()];
    for (const e of s.events) {
      if ((e.type === 'Summon' && !e.mimic) || e.type === 'SpellCast' || e.type === 'JokerReveal') played[e.p]?.add(e.id);
    }
    out.push({ a, b, w: s.winner, r: s.endReason, t: s.turn[0] + s.turn[1], played: played.map((x) => [...x]) });
  }
  parentPort.postMessage(out);
}
