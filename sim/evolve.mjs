// Deck search: for every element pair, hill-climb its deck against the current best decks of the other pairs.
// Removes the bias of a hand-written deck list, so the deck gate measures cards, not the deck-building rule.
// node sim/evolve.mjs [rounds=3] [steps=24] [games per opponent=24]  ->  data/decks_evolved.json
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { loadDb, buildDecks, playGame } from './game.js';

if (isMainThread) {
  const [rounds = 3, steps = 24, games = 24] = process.argv.slice(2).map(Number);
  const db = loadDb();
  let field = buildDecks(db).filter((d) => !d.joker).map((d) => ({ name: d.name, cards: d.cards }));
  for (let r = 1; r <= rounds; r++) {
    const t0 = Date.now();
    const next = await Promise.all(field.map((_, i) => new Promise((res, rej) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { i, field, steps, games, round: r } });
      w.on('message', res);
      w.on('error', rej);
    })));
    field = next.map((n) => ({ name: n.name, cards: n.cards, fitness: n.fitness, from: n.from }));
    console.log(`round ${r} (${((Date.now() - t0) / 1000).toFixed(0)} s): ${field.map((d) => `${d.name} ${(d.from * 100).toFixed(0)}>${(d.fitness * 100).toFixed(0)}`).join(', ')}`);
  }
  writeFileSync(new URL('../data/decks_evolved.json', import.meta.url), JSON.stringify(field, null, 1));
  console.log('wrote data/decks_evolved.json');
} else {
  const { i, field, steps, games, round } = workerData;
  const db = loadDb();
  const me = field[i];
  const pool = [...new Set(buildDecks(db).filter((d) => d.name === me.name)[0].cards)];
  // the same seeds for the current deck and the candidate, so the comparison is paired
  const fitness = (cards) => {
    let w = 0, n = 0;
    field.forEach((opp, j) => {
      if (j === i) return;
      for (let g = 0; g < games; g++) {
        const seed = 100000 * round + 1000 * j + g + 1;
        const first = g % 2 === 0;
        const s = playGame(db, first ? cards : opp.cards, first ? opp.cards : cards, seed);
        if (s.winner === 'draw') continue;
        n++;
        if (s.winner === (first ? 0 : 1)) w++;
      }
    });
    return w / n;
  };
  let rnd = 12345 + i * 77 + round * 991;
  const rand = (k) => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd % k; };
  let cards = me.cards.slice();
  const from = fitness(cards);
  let best = from;
  for (let step = 0; step < steps; step++) {
    const count = (id) => cards.filter((c) => c === id).length;
    const out = cards[rand(cards.length)];
    const options = pool.filter((id) => id !== out && count(id) < 2);
    if (!options.length) continue;
    const add = options[rand(options.length)];
    const cand = cards.slice();
    cand.splice(cand.indexOf(out), 1);
    cand.push(add);
    const f = fitness(cand);
    if (f > best + 0.01) { best = f; cards = cand; }
  }
  parentPort.postMessage({ name: me.name, cards: cards.sort(), fitness: best, from });
}
