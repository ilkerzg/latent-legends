// Same seed and decks must give the same event log, game after game, for every bot level;
// the bots must leave the state they read untouched, and the lane rule must fire in these games.
import { loadDb, buildDecks, playGame } from './game.js';
import { STARTERS } from '../engine/deck.js';
import { BOTS } from './bots/greedy.js';
const db = loadDb();
const decks = buildDecks(db).map((d) => d.cards).concat(Object.values(STARTERS).map((d) => d.cards));
const seen = { LaneClosed: 0, Relocate: 0, Recall: 0 };
let ok = 0;
const check = (seed, bots) => {
  const a = decks[seed % decks.length], b = decks[(seed * 3) % decks.length];
  const run = () => playGame(db, a, b, seed, bots, { log: true }).events;
  const e1 = run();
  if (JSON.stringify(e1) !== JSON.stringify(run())) { console.log(`seed ${seed} ${bots}: replay differs`); process.exit(1); }
  for (const e of e1) if (e.type in seen) seen[e.type]++;
  ok++;
};
for (let seed = 1; seed <= 200; seed++) check(seed, ['greedy', 'greedy']);
for (let seed = 201; seed <= 230; seed++) check(seed, seed % 2 ? ['easy', 'hard'] : ['hard', 'normal']);
// a bot only reads: the state is the same after it decides
const snap = (s) => JSON.stringify({ ...s, db: null });
playGame(db, decks[0], decks[1], 7, ['greedy', 'greedy'], { onStep(s) {
  if (s.phase === 'over') return;
  const was = snap(s);
  for (const k of ['easy', 'normal', 'hard']) BOTS[k](s);
  if (snap(s) !== was) { console.log('a bot changed the state it read'); process.exit(1); }
} });
if (!seen.LaneClosed || !seen.Relocate || !seen.Recall) { console.log(`lane rule never fired: ${JSON.stringify(seen)}`); process.exit(1); }
console.log(`determinism ok: ${ok} replays identical; ${seen.LaneClosed} lane closures, ${seen.Relocate} relocations, ${seen.Recall} recalls`);
