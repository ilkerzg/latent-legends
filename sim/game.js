// Shared by the runner, its workers and the CLI: decks, one full game, the card database.
import { readFileSync } from 'node:fs';
import { ELEMENTS, indexCards, newGame, apply } from '../engine/rules.js';
import { BOTS } from './bots/greedy.js';

export function loadDb() {
  const { cards } = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
  return indexCards(cards);
}

const JOKER_PAIRS = [['mirror', 'swap'], ['mimic', 'rebirth'], ['spark', 'swap'], ['mirror', 'rebirth'], ['mimic', 'spark']];

// every two-element pair: its 10 characters, 4 spells and second copies of the three cheapest Front
// and the three cheapest Back characters, so no deck runs out of Front units.
// The joker version swaps the two most expensive copies for two jokers.
export function buildDecks(db, evolved = null) {
  if (evolved) return fromEvolved(evolved);
  const all = Object.values(db);
  const decks = [];
  let k = 0;
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++) {
      const els = [ELEMENTS[i], ELEMENTS[j]];
      const us = all.filter((c) => c.type === 'unit' && els.includes(c.element)).sort((a, b) => a.cost - b.cost);
      const sp = all.filter((c) => c.type === 'spell' && els.includes(c.element));
      const front = us.filter((c) => c.role === 'Tank' || c.role === 'Fighter').slice(0, 3);
      const back = us.filter((c) => c.role !== 'Tank' && c.role !== 'Fighter').slice(0, 3);
      const dupes = [...front, ...back].sort((a, b) => a.cost - b.cost);
      const base = [...us, ...sp, ...dupes].map((c) => c.id);
      const jokers = JOKER_PAIRS[k++ % JOKER_PAIRS.length];
      const withJ = [...us, ...sp, ...dupes.slice(0, 4)].map((c) => c.id).concat(jokers);
      decks.push({ name: `${els[0]}-${els[1]}`, cards: base, joker: false });
      decks.push({ name: `${els[0]}-${els[1]}+J`, cards: withJ, joker: true, jokers });
    }
  return decks;
}

// searched decks (sim/evolve.mjs); each joker version drops one copy of its two most expensive doubled cards
function fromEvolved(list) {
  const out = [];
  list.forEach((d, k) => {
    const doubled = [...new Set(d.cards.filter((id, i) => d.cards.indexOf(id) !== i))];
    const jokers = JOKER_PAIRS[k % JOKER_PAIRS.length];
    const withJ = d.cards.slice();
    const db = loadDb();
    for (const id of doubled.sort((a, b) => db[b].cost - db[a].cost).slice(0, 2)) withJ.splice(withJ.indexOf(id), 1);
    while (withJ.length > 18) withJ.pop();
    out.push({ name: d.name, cards: d.cards, joker: false });
    out.push({ name: `${d.name}+J`, cards: withJ.concat(jokers), joker: true, jokers });
  });
  return out;
}

export function loadEvolved() {
  return JSON.parse(readFileSync(new URL('../data/decks_evolved.json', import.meta.url)));
}

export function playGame(db, deck0, deck1, seed, bots = ['greedy', 'greedy'], opts = {}) {
  const s = newGame(db, [deck0, deck1], seed, opts);
  const holder = { rng: (seed * 7919) >>> 0 || 1 };
  const rnd = () => { let t = (holder.rng = (holder.rng + 0x6d2b79f5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let guard = 0;
  while (s.phase !== 'over') {
    const a = BOTS[bots[s.active]](s, rnd);
    apply(s, a);
    if (opts.onStep) opts.onStep(s, a);
    if (++guard > 5000) throw new Error('runaway game');
  }
  return s;
}
