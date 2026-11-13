// Hidden information (engine/hidden.js): a room plays the real game, each client plays the same match from what its
// seat may see. In every game, after every action, each client must agree with the room on everything public and on
// its own hand, and must never hold a card id the seat may not see. The clients pick the moves with the bots (from
// their own view, as the auto combat does online), so the bots must also work on a hidden state.
// The room orders the decks with the dice it is given and with nothing else: here a seeded one, so a failure can be
// played again; the servers pass their cryptographic generator.
import { loadDb, buildDecks } from './game.js';
import { STARTERS } from '../engine/deck.js';
import { newGame, apply, legalActions, reveal, HIDDEN } from '../engine/rules.js';
import { deal, redeal, shuffled, play, seen, dealtFor, listOf } from '../engine/hidden.js';
import { next } from '../engine/rng.js';
import { BOTS } from './bots/greedy.js';

const db = loadDb();
const decks = buildDecks(db).map((d) => d.cards).concat(Object.values(STARTERS).map((d) => d.cards));
const fail = (msg) => { console.log(`hidden: ${msg}`); process.exit(1); };
const pub = (s) => JSON.stringify({
  board: s.board, closed: s.closed, phase: s.phase, active: s.active, turn: s.turn, winner: s.winner, lastUnit: s.lastUnit,
  players: s.players.map((p) => ({ shrines: p.shrines, essence: p.essence, moved: p.moved, grave: p.grave, played: p.played, hand: p.hand.length, deck: p.deck.length })),
});
// rand(n) for deal(): whole numbers from 0 to n - 1, the same run for the same seed; rolls counts the calls
const dice = (seed) => { const h = { rng: seed }, rand = (n) => (rand.rolls++, Math.floor(next(h) * n)); rand.rolls = 0; return rand; };
let games = 0, actions = 0, burned = 0;
for (let seed = 1; seed <= 120; seed++) {
  const pair = [decks[seed % decks.length], decks[(seed * 7) % decks.length]];
  const rand = dice(seed), room = deal(db, pair, rand, {});
  const R = room.s;
  // the order comes from the dice alone: one roll for each card but the last, the same order for the same rolls, and
  // the game itself never shuffles (its own generator is left where a dealt game starts it)
  if (rand.rolls !== pair[0].length + pair[1].length - 2) fail(`seed ${seed}: ${rand.rolls} rolls for the two decks`);
  const again = dice(seed);
  if (JSON.stringify(room.dealt) !== JSON.stringify(pair.map((d) => shuffled(d, again)))) fail(`seed ${seed}: the dealt order is not the dice's`);
  if (R.rng !== 1 || !R.cfg.dealt) fail(`seed ${seed}: the room's game was not dealt`);
  const C = [0, 1].map((seat) => newGame(db, dealtFor(room, seat), 0, { ...R.cfg, log: false, dealt: true, lanes: R.terrain }));
  // the dealt decks are the real decks in a new order
  for (const p of [0, 1]) if (JSON.stringify(listOf(pair[p])) !== JSON.stringify(listOf(room.dealt[p]))) fail(`seed ${seed}: dealt deck ${p} is not the deck`);
  const level = ['greedy', 'easy', 'hard'][seed % 3];
  for (let i = 0; i < 2000 && R.phase !== 'over'; i++) {
    const me = R.active, a = BOTS[level](C[me]);
    // the move a client picks from its own view must be legal in the real game
    if (!legalActions(R).some((x) => JSON.stringify(x) === JSON.stringify(a))) fail(`seed ${seed}: client ${me} picked an illegal move ${JSON.stringify(a)}`);
    const d = play(R, a);
    burned += d.flat().filter(([, b]) => b).length;
    for (const seat of [0, 1]) { reveal(C[seat], seen(d, seat)); apply(C[seat], a); }
    actions++;
    for (const seat of [0, 1]) {
      const c = C[seat];
      if (pub(c) !== pub(R)) fail(`seed ${seed} action ${i}: seat ${seat} disagrees with the room\n${pub(c)}\n${pub(R)}`);
      if (JSON.stringify(c.players[seat].hand) !== JSON.stringify(R.players[seat].hand)) fail(`seed ${seed} action ${i}: seat ${seat} has the wrong hand`);
      // the opponent's hand: only cards that came back from the board (recall, rebirth) or the second player's spark show
      const foe = c.players[1 - seat];
      if (c.players[seat].deck.some((id) => id !== HIDDEN) || foe.deck.some((id) => id !== HIDDEN)) fail(`seed ${seed}: seat ${seat} can see a deck`);
      const known = foe.hand.filter((id) => id !== HIDDEN);
      const real = R.players[1 - seat].hand.slice();
      for (const id of known) { const k = real.indexOf(id); if (k < 0) fail(`seed ${seed}: seat ${seat} sees ${id} that is not in the opponent's hand`); real.splice(k, 1); }
    }
  }
  if (R.phase !== 'over') fail(`seed ${seed}: the game did not end`);
  games++;
}
// what a client sees of the opening: its own hand only
const room = deal(db, [decks[0], decks[1]], dice(99), {});
const v0 = dealtFor(room, 0), opening = (deck) => deck.filter((id) => id !== HIDDEN).length;
if (opening(v0[0]) !== room.opening[0].length || opening(v0[1]) !== 0) fail('the opening view shows the wrong cards');
// a stored room builds the same match again from the order it dealt
const back = redeal(db, room.dealt, room.lanes, {});
if (JSON.stringify(back.opening) !== JSON.stringify(room.opening) || JSON.stringify(back.s.players) !== JSON.stringify(room.s.players)) fail('a match built again from its dealt order differs');
// different dice, different orders; and with the terrain option the lanes come from the dice too
if (JSON.stringify(deal(db, [decks[0], decks[1]], dice(100), {}).dealt) === JSON.stringify(room.dealt)) fail('two deals came out in the same order');
const lanes = deal(db, [decks[0], decks[1]], dice(5), { terrain: 'atk' });
if (lanes.lanes?.length !== 3 || JSON.stringify(lanes.s.terrain) !== JSON.stringify(lanes.lanes)) fail('the lanes of a dealt match are not the dice\'s');
console.log(`hidden ok: ${games} games, ${actions} actions, both clients agree with the room and never see a hidden card (${burned} burned cards shown)`);
