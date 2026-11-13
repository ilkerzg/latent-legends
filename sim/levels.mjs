// Bot against bot on the starter decks (engine/deck.js), every ordered deck pair, on all CPU cores.
// node sim/levels.mjs [games per ordered deck pair] [botA,botB] [--seed=1] [--json]
// Every seed is played twice, once with each bot moving first (once when both bots are the same). Prints win rates, first-player edge,
// game length, lane closures and the bots' thinking time per decision.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { STARTERS } from '../engine/deck.js';
import { newGame, apply } from '../engine/rules.js';
import { loadDb } from './game.js';
import { BOTS } from './bots/greedy.js';

const COUNT = ['LaneClosed', 'Relocate', 'Recall'];

if (isMainThread) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const n = Number(pos[0] || 50);
  const bots = (pos[1] || 'greedy,greedy').split(',');
  const seed0 = Number(args.find((a) => a.startsWith('--seed='))?.split('=')[1] || 1);
  const keys = Object.keys(STARTERS);
  const jobs = [];
  let seed = seed0;
  for (const a of keys) for (const b of keys) for (let g = 0; g < n; g++, seed++) for (const first of bots[0] === bots[1] ? [0] : [0, 1]) jobs.push([a, b, seed, first]);
  const workers = Math.max(1, cpus().length - 2);
  const chunks = Array.from({ length: workers }, (_, w) => jobs.filter((_, i) => i % workers === w));
  const t0 = Date.now();
  const res = (await Promise.all(chunks.map((chunk) => new Promise((ok, fail) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { chunk, bots } });
    w.on('message', ok);
    w.on('error', fail);
  })))).flat();
  const N = res.length, pct = (x) => `${(100 * x).toFixed(1)}%`;
  const winsA = res.filter((g) => g.w === g.first).length, draws = res.filter((g) => g.w === 'draw').length;
  const decisive = res.filter((g) => g.w !== 'draw');
  const p1 = decisive.filter((g) => g.w === 0).length / decisive.length;
  const avg = (f) => res.reduce((x, g) => x + f(g), 0) / N;
  const reasons = {};
  for (const g of res) reasons[g.r] = (reasons[g.r] || 0) + 1;
  const time = (k) => {
    let ms = 0, d = 0, mx = 0;
    for (const g of res) { const seat = k === 0 ? g.first : 1 - g.first; ms += g.ms[seat]; d += g.d[seat]; mx = Math.max(mx, g.mx[seat]); }
    return `${(ms / d).toFixed(2)} ms avg, ${mx.toFixed(0)} ms max over ${d} decisions`;
  };
  const summary = {
    games: N, bots, secs: (Date.now() - t0) / 1000,
    aWin: winsA / N, aWinDecisive: winsA / decisive.length, draws: draws / N, firstPlayerWin: p1,
    turns: avg((g) => g.t), rounds: avg((g) => Math.ceil(g.t / 2)), reasons,
    perGame: Object.fromEntries([...COUNT, 'Lost'].map((k) => [k, avg((g) => g.ev[k])])),
    gamesWithClosure: res.filter((g) => g.ev.LaneClosed > 0).length / N,
  };
  if (args.includes('--json')) { console.log(JSON.stringify(summary)); process.exit(0); }
  console.log(`${N} games, ${bots[0]} vs ${bots[1]}, ${summary.secs.toFixed(1)} s on ${workers} workers`);
  console.log(`${bots[0]} wins ${pct(summary.aWin)} (draws ${pct(summary.draws)}; ${pct(summary.aWinDecisive)} of decisive games)`);
  console.log(`first player wins ${pct(p1)} of decisive games; ${summary.turns.toFixed(1)} turns (${summary.rounds.toFixed(1)} rounds) per game`);
  console.log(`end: ${Object.entries(reasons).map(([k, v]) => `${k} ${pct(v / N)}`).join(', ')}`);
  console.log(`per game: ${Object.entries(summary.perGame).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}; a lane closed in ${pct(summary.gamesWithClosure)} of games`);
  console.log(`think time ${bots[0]}: ${time(0)}`);
  console.log(`think time ${bots[1]}: ${time(1)}`);
} else {
  const { chunk, bots } = workerData;
  const db = loadDb();
  const out = [];
  for (const [a, b, seed, first] of chunk) {
    // first = seat of bots[0]; the deck pair stays in its seats
    const seatBot = first === 0 ? bots : [bots[1], bots[0]];
    const s = newGame(db, [STARTERS[a].cards, STARTERS[b].cards], seed, { log: true });
    const holder = { rng: (seed * 7919) >>> 0 || 1 };
    const rnd = () => { let t = (holder.rng = (holder.rng + 0x6d2b79f5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const ms = [0, 0], d = [0, 0], mx = [0, 0], ev = { LaneClosed: 0, Relocate: 0, Recall: 0, Lost: 0 };
    let guard = 0;
    while (s.phase !== 'over') {
      const p = s.active, t0 = performance.now();
      const act = BOTS[seatBot[p]](s, rnd);
      const dt = performance.now() - t0;
      ms[p] += dt; d[p]++; mx[p] = Math.max(mx[p], dt);
      apply(s, act);
      if (++guard > 5000) throw new Error('runaway game');
    }
    for (const e of s.events) {
      if (e.type in ev) ev[e.type]++;
      if (e.type === 'Recall' && e.lost) ev.Lost++;
    }
    out.push({ a, b, seed, first, w: s.winner, r: s.endReason, t: s.turn[0] + s.turn[1], ms, d, mx, ev });
  }
  parentPort.postMessage(out);
}
