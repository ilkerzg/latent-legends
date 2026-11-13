// The room's side of hidden information (rules.js HIDDEN and reveal): what each seat of an online match may see.
// The room shuffles both decks itself and keeps the real game and the order it dealt. A seat gets both deck lists only
// as sorted lists (to load their art), its own opening hand, every action, and with each action the cards it drew. The
// opponent's draws stay HIDDEN, except a card burned from a full hand: the log names it, so both players see it.
// Used by server/rooms.mjs and cloudflare/worker.js.
import { newGame, apply, HIDDEN, ELEMENTS } from './rules.js';

// the cards each player drew since the last call, in draw order, as [id, burned]; clears the state's events
export function draws(s) {
  const out = [[], []];
  for (const e of s.events.splice(0)) if (e.type === 'Draw' || e.type === 'Burned') out[e.p].push([e.id, e.type === 'Burned']);
  return out;
}

// a deck in a new order. rand(n) gives a whole number from 0 to n - 1, each equally likely. A room passes its platform's
// cryptographic generator: the order of a deck shuffled from a small seed can be worked out from the cards its own
// player draws, and with it the other player's hand
export function shuffled(deck, rand) {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// a new match: both decks shuffled with rand (and the lanes' elements drawn with it, when the terrain option is on)
export function deal(db, decks, rand, opts = {}) {
  const lanes = (opts.terrain ?? 'off') === 'off' ? null : [0, 1, 2].map(() => ELEMENTS[rand(ELEMENTS.length)]);
  return redeal(db, decks.map((d) => shuffled(d, rand)), lanes, opts);
}

// the match of two decks already in the order they are dealt from (the top card last): the real game, that order and
// the opening draws. A room that stores a match keeps the order and the lanes, and builds the game again from them
export function redeal(db, order, lanes, opts = {}) {
  const s = newGame(db, order, 0, { ...opts, log: true, dealt: true, lanes });
  return { s, dealt: order.map((d) => d.slice()), lanes, opening: draws(s) };
}

// one accepted action on the real game; returns the draws it made
export function play(s, a) {
  apply(s, a);
  return draws(s);
}

// what seat may see of some draws
export const seen = (d, seat) => d.map((list, p) => list.map(([id, burned]) => (p === seat || burned ? id : HIDDEN)));

// the dealt decks as seat may see them: only its own opening draws (and any burned card) show
export function dealtFor({ dealt, opening }, seat) {
  return dealt.map((deck, p) => deck.map((id, i) => {
    const k = deck.length - 1 - i, pop = opening[p][k];
    return pop && (p === seat || pop[1]) ? id : HIDDEN;
  }));
}

// a deck list without its order
export const listOf = (deck) => deck.slice().sort();
