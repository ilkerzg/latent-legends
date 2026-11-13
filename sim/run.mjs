// Round robin of bot matches across every deck pair, on all CPU cores.
// node sim/run.mjs [games per ordered pair] [bot0,bot1] [--terrain=atk|mana] [--comeback] [--out=name]
// Writes out/balance/<name>.json; sim/report.mjs turns it into HTML.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadDb, buildDecks, loadEvolved, playGame } from './game.js';

if (isMainThread) {
  const args = process.argv.slice(2);
  const flag = (k) => args.find((a) => a.startsWith(`--${k}`));
  const pos = args.filter((a) => !a.startsWith('--'));
  const n = Number(pos[0] || 40);
  const bots = (pos[1] || 'greedy,greedy').split(',');
  // every --key=value becomes an engine option (numbers and true/false are parsed)
  const opts = {};
  const evolved = !!flag('evolved');
  for (const a of args.filter((x) => x.startsWith('--') && !x.startsWith('--out') && !x.startsWith('--evolved'))) {
    const [k, v] = a.slice(2).split('=');
    opts[k] = v === undefined || v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);
  }
  const outName = flag('out')?.split('=')[1] || 'results';
  const db = loadDb();
  const decks = buildDecks(db, evolved ? loadEvolved() : null);
  // base decks play each other (mirrors included); each joker deck plays every base deck in both seats
  const jobs = [];
  let seed = 1;
  const base = decks.map((d, i) => [d, i]).filter(([d]) => !d.joker).map(([, i]) => i);
  const joker = decks.map((d, i) => [d, i]).filter(([d]) => d.joker).map(([, i]) => i);
  for (const a of base) for (const b of base) for (let g = 0; g < n; g++) jobs.push([a, b, seed++]);
  for (const j of joker) for (const b of base) for (let g = 0; g < Math.ceil(n / 2); g++) { jobs.push([j, b, seed++]); jobs.push([b, j, seed++]); }
  const workers = Math.max(1, cpus().length - 2);
  const chunks = Array.from({ length: workers }, (_, w) => jobs.filter((_, i) => i % workers === w));
  const t0 = Date.now();
  const results = (await Promise.all(chunks.map((chunk) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { chunk, bots, opts, evolved } });
    w.on('message', res);
    w.on('error', rej);
  })))).flat();
  const secs = (Date.now() - t0) / 1000;
  mkdirSync(new URL('../out/balance/', import.meta.url), { recursive: true });
  const out = { meta: { games: results.length, perPair: n, bots, opts, secs, workers, decks: decks.map((d) => ({ name: d.name, joker: d.joker, jokers: d.jokers || [] })) }, results };
  writeFileSync(new URL(`../out/balance/${outName}.json`, import.meta.url), JSON.stringify(out));
  console.log(`${results.length} games in ${secs.toFixed(1)} s on ${workers} workers -> out/balance/${outName}.json`);
} else {
  const { chunk, bots, opts, evolved } = workerData;
  const db = loadDb();
  const decks = buildDecks(db, evolved ? loadEvolved() : null);
  const res = [];
  for (const [a, b, seed] of chunk) {
    const s = playGame(db, decks[a].cards, decks[b].cards, seed, bots, opts);
    res.push({
      a, b, w: s.winner, r: s.endReason, t: s.turn[0] + s.turn[1],
      p: s.players.map((pl) => [...new Set(pl.played)]),
      hp: s.players.map((pl) => pl.shrines.reduce((x, y) => x + y, 0)),
      s5: s.snap5, mg: s.stats.manaGain, mw: s.stats.manaWasted, sk: s.stats.skills, at: s.stats.attacks,
    });
  }
  parentPort.postMessage(res);
}
