// Greedy bot: tries every legal action on a copy of the state and keeps the one with the best score.
// One step deep, so it plays well locally and knows nothing about the opponent's next turn.
// BOT_LEVELS (easy, normal, hard) are the difficulties for play against the computer; all are (s) => action
// and deterministic: any dice they roll come from the state itself, never from Math.random.
import { apply, clone, legalActions, units, FRONT_SLOT, BACK_SLOT } from '../../engine/rules.js';
import { next as roll01, shuffle } from '../../engine/rng.js';

export function evaluate(s, me) {
  if (s.winner !== null) return s.winner === me ? 1e6 : s.winner === 'draw' ? 0 : -1e6;
  let v = 0;
  for (const p of [0, 1]) {
    const sign = p === me ? 1 : -1, foe = 1 - p, pl = s.players[p];
    const full = s.cfg.shrineHp + (p === 1 ? s.cfg.p1ShrineBonus : 0);
    let down = 0;
    // a standing Shrine in a closed lane can never be hit again, so it counts as a full one
    for (let lane = 0; lane < 3; lane++) { const hp = pl.shrines[lane]; v += sign * 2 * (hp > 0 && s.closed[lane] ? full : hp); if (hp <= 0) down++; }
    v -= sign * down * 25;
    v += sign * Math.min(pl.hand.length, 7) * 0.6;
    // no unit ever stands in a closed lane: the engine moves them out when it closes
    for (const [u, lane, slot] of units(s, p)) {
      if (!u.acts) { v += sign * (u.hp * 0.5 + u.armor); continue; }
      v += sign * (u.atk * 1.3 + u.hp + u.armor * 1.5 + u.ward * 0.7 + u.mana * 0.5 + u.thorns);
      if (!s.board[lane][foe][FRONT_SLOT] && s.players[foe].shrines[lane] > 0) v += sign * Math.min(u.atk, s.players[foe].shrines[lane]) * 1.2;
      if (u.taunt && s.board[lane][p][BACK_SLOT]) v += sign * 2.5;
      if (u.burn) v -= sign * u.burn;
      if (u.frozen) v -= sign * 2;
      if (slot === BACK_SLOT && u.hp <= 5) {
        // exposed back unit: an enemy Fighter with Dive one Start away
        const f = s.board[lane][foe][FRONT_SLOT];
        if (f && f.skill && f.skill.id === 'dive' && f.mana + 1 >= 2 && !tauntIn(s, lane, p)) v -= sign * Math.min(u.hp, f.skill.power) * 0.6;
      }
    }
  }
  return v;
}

function tauntIn(s, lane, side) {
  const lanes = s.board[lane][side];
  return (lanes[0] && lanes[0].taunt) || (lanes[1] && lanes[1].taunt);
}

// every legal action with its one-step score, in legalActions order
export function scored(s, depth = 1) {
  const me = s.active;
  const base = evaluate(s, me);
  return legalActions(s).map((a) => {
    if (a.t === 'end') return { a, score: base };
    const next = apply(clone(s), a);
    let score = evaluate(next, me);
    // a Main action that changes nothing on the board by itself (Spark, Swap, Gravity Well, a move)
    // is scored by the best follow-up it opens up
    if (depth > 0 && s.phase === 'main' && next.phase === 'main' && next.active === me && score <= base + 0.01) {
      const follow = greedy(next, depth - 1);
      if (follow.t !== 'end') score = Math.max(score, evaluate(apply(clone(next), follow), me) - 0.01);
    }
    return { a, score };
  });
}

export function greedy(s, depth = 1) {
  let best = null;
  for (const x of scored(s, depth)) if (!best || x.score > best.score + 1e-9) best = x;
  return best?.a;
}

export function random(s, rnd) {
  const acts = legalActions(s);
  return acts[Math.floor(rnd() * acts.length)];
}

// ---------- difficulty levels ----------

// a dice holder seeded from the state: same state, same rolls. s.rng itself stays untouched (it is fixed
// after setup), so the turn, the board and the hands are mixed in to give each decision its own roll.
function dice(s, perTurn = false) {
  let h = (s.rng ^ 0x9e3779b9) >>> 0;
  const mix = (x) => { h = Math.imul(h ^ (x | 0), 0x85ebca6b); h ^= h >>> 13; };
  mix(s.turn[0]); mix(s.turn[1]); mix(s.active);
  if (!perTurn) {
    mix(s.uid); mix(s.queue.length); mix(s.phase === 'main' ? 1 : 2);
    for (const pl of s.players) { mix(pl.essence); mix(pl.hand.length); mix(pl.moved ? 1 : 0); }
    for (const lane of s.board) for (const side of lane) for (const u of side) if (u) { mix(u.uid); mix(u.hp); mix(u.mana); }
  }
  const holder = { rng: h >>> 0 || 1 };
  return () => roll01(holder);
}

// easy: greedy's own scores, played sloppily. On 3 turns in 5 it forgets its spells and jokers, and each
// decision picks one of the three best actions within EASY.margin of the best (40/35/25), so it never
// throws away a Shrine or a big unit for nothing. Tuned so normal beats it about 3 games in 4.
export const EASY = { skipSpells: 0.6, margin: 10, odds: [0.4, 0.75] };
export function easy(s) {
  let opts = scored(s);
  if (opts.length < 2) return opts[0]?.a;
  if (s.phase === 'main' && dice(s, true)() < EASY.skipSpells) opts = opts.filter((x) => x.a.t !== 'play' || s.db[x.a.id].type === 'unit');
  opts.sort((x, y) => y.score - x.score);
  const top = opts.filter((x) => x.score >= opts[0].score - EASY.margin).slice(0, 3);
  const r = dice(s)();
  return (top[r < EASY.odds[0] ? 0 : r < EASY.odds[1] ? 1 : 2] || top[0]).a;
}

// hard: greedy's best HARD.k actions, each played out on a copy by greedy for both sides (the rest of this
// turn, the opponent's reply, and so on for HARD.turns rounds) and scored at the start of this player's
// turn after that. It does not peek: in each of HARD.worlds copies the opponent's hand is redrawn at random
// from the cards it could hold (its hand and deck), and both decks are reshuffled. Capped by count, not by
// clock: about 1 ms a decision, 15 ms at worst, on an M4 Pro in Node.
export const HARD = { k: 8, worlds: 3, turns: 2 };
export function hard(s) {
  const me = s.active;
  const opts = scored(s).sort((x, y) => y.score - x.score).slice(0, HARD.k);
  if (opts.length < 2) return opts[0]?.a;
  const roll = dice(s);
  const worlds = Array.from({ length: HARD.worlds }, () => unseen(s, me, roll));
  let best = opts[0], bestV = -Infinity;
  for (const x of opts) {
    let v = 0;
    for (const w of worlds) v += playout(apply(clone(w), x.a), me);
    if (v > bestV + 1e-9) { bestV = v; best = x; }
  }
  return best.a;
}

// a copy of s as `me` can see it: the opponent's hand redrawn from its hand and deck, both decks reshuffled
function unseen(s, me, roll) {
  const w = clone(s), holder = { rng: (roll() * 4294967296) >>> 0 || 1 };
  const op = w.players[1 - me], pool = shuffle(holder, op.hand.concat(op.deck));
  op.hand = pool.slice(0, op.hand.length);
  op.deck = pool.slice(op.hand.length);
  shuffle(holder, w.players[me].deck);
  return w;
}

function playout(t, me) {
  const turn = t.turn[me];
  for (let guard = 0; t.phase !== 'over' && !(t.active === me && t.turn[me] >= turn + HARD.turns) && guard < 400 * HARD.turns; guard++) apply(t, greedy(t));
  return evaluate(t, me);
}

export const BOT_LEVELS = { easy, normal: (s) => greedy(s), hard };
export const BOTS = { greedy: (s) => greedy(s), random: (s, rnd) => random(s, rnd), ...BOT_LEVELS };
