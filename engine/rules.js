// Latent Legends rules engine. Pure state machine, no DOM: newGame, legalActions, apply, clone.
// The client and the simulator share this file. Rules are in RULES.md.
import { next, shuffle } from './rng.js';

export const ELEMENTS = ['Fire', 'Wild', 'Storm', 'Frost', 'Shadow'];
export const ROLES = ['Tank', 'Fighter', 'Mage', 'Archer', 'Support'];
const FRONT = new Set(['Tank', 'Fighter', 'Wall']);
export const FRONT_SLOT = 0, BACK_SLOT = 1;

export const DEFAULTS = {
  shrineHp: 9, maxEssence: 8, turnLimit: 16, handLimit: 7, startHand: [4, 5],
  moveCost: 1, terrain: 'off', comeback: false, secondPlayerSparks: 1,
  // balance experiments (RULES.md, Options)
  p1ShrineBonus: 1, diveFallback: true, noSpells: false, noElements: false,
};

export function beats(a, b) {
  if (!a || !b) return false;
  const d = (ELEMENTS.indexOf(b) - ELEMENTS.indexOf(a) + 5) % 5;
  return d === 1 || d === 3;
}
export const elemMod = (a, b) => (beats(a, b) ? 1 : beats(b, a) ? -1 : 0);
const elemModCfg = (s, a, b) => (s.cfg.noElements ? 0 : elemMod(a, b));
export const slotFor = (role) => (FRONT.has(role) ? FRONT_SLOT : BACK_SLOT);

export function indexCards(cards) {
  const db = {};
  for (const c of cards) db[c.id] = c;
  return db;
}

// ---------- setup ----------

// A card a player may not see: an online client gets the opponent's hand and both decks with these in place of ids,
// and the room tells it each card it may see as it is drawn (reveal). A dealt game (opts.dealt) takes the decks in the
// order they are dealt from and never shuffles: an online room orders them itself (engine/hidden.js), and its seed is
// only for local play, the bots and the simulator.
export const HIDDEN = '?';

export function newGame(db, decks, seed = 1, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const s = {
    db, cfg, rng: (seed >>> 0) || 1, active: 0, phase: 'main', queue: [], turn: [0, 0],
    winner: null, endReason: null, uid: 0, lastUnit: null, log: !!opts.log, events: [], terrain: null, closed: [false, false, false],
    snap5: null, stats: { manaGain: [0, 0], manaWasted: [0, 0], skills: [0, 0], attacks: [0, 0] },
    players: [0, 1].map((p) => ({
      deck: decks[p].slice(), hand: [], grave: [], played: [], shrines: [0, 1, 2].map(() => cfg.shrineHp + (p === 1 ? cfg.p1ShrineBonus : 0)),
      essence: 0, moved: false,
    })),
    board: [0, 1, 2].map(() => [[null, null], [null, null]]),
  };
  if (cfg.terrain !== 'off') s.terrain = opts.dealt ? opts.lanes ?? null : [0, 1, 2].map(() => ELEMENTS[Math.floor(next(s) * 5)]);
  for (const p of [0, 1]) {
    if (!opts.dealt) shuffle(s, s.players[p].deck);
    for (let i = 0; i < cfg.startHand[p]; i++) draw(s, p);
  }
  if (db.spark) for (let i = 0; i < cfg.secondPlayerSparks; i++) s.players[1].hand.push('spark');
  startTurn(s, 0);
  return s;
}

// r[p] lists player p's next draws in the order they are drawn, HIDDEN for the ones this screen may not see; they go on
// top of the deck before the action that draws them is applied
export function reveal(s, r) {
  if (!r) return;
  for (const p of [0, 1]) {
    const deck = s.players[p].deck;
    (r[p] ?? []).forEach((id, i) => { if (deck.length - 1 - i >= 0) deck[deck.length - 1 - i] = id; });
  }
}

export function clone(s) {
  return {
    ...s,
    queue: s.queue.slice(), turn: s.turn.slice(), closed: s.closed.slice(), events: [], log: false,
    stats: { manaGain: s.stats.manaGain.slice(), manaWasted: s.stats.manaWasted.slice(), skills: s.stats.skills.slice(), attacks: s.stats.attacks.slice() },
    players: s.players.map((p) => ({ ...p, deck: p.deck.slice(), hand: p.hand.slice(), grave: p.grave.slice(), played: p.played.slice(), shrines: p.shrines.slice() })),
    board: s.board.map((lane) => lane.map((side) => [side[0] && { ...side[0] }, side[1] && { ...side[1] }])),
  };
}

// ---------- helpers ----------

const emit = (s, e) => { if (s.log) s.events.push(e); };
// a lane closes for both players when either Shrine in it falls (RULES.md, Closed lanes)
export const isOpen = (s, lane) => lane >= 0 && lane < 3 && !s.closed[lane];

function draw(s, p) {
  const pl = s.players[p];
  if (!pl.deck.length) return;
  const id = pl.deck.pop();
  if (pl.hand.length >= s.cfg.handLimit) { pl.grave.push(id); emit(s, { type: 'Burned', p, id }); return; }
  pl.hand.push(id);
  emit(s, { type: 'Draw', p, id });
}

export function* units(s, side) {
  for (let lane = 0; lane < 3; lane++)
    for (let slot = 0; slot < 2; slot++) {
      const u = s.board[lane][side][slot];
      if (u) yield [u, lane, slot];
    }
}

export function findUnit(s, uid) {
  for (let lane = 0; lane < 3; lane++)
    for (let side = 0; side < 2; side++)
      for (let slot = 0; slot < 2; slot++) {
        const u = s.board[lane][side][slot];
        if (u && u.uid === uid) return [u, lane, side, slot];
      }
  return null;
}

function makeUnit(s, card, owner, lane, override = {}) {
  const u = {
    uid: ++s.uid, id: card.id, name: card.name, owner, element: card.element, role: card.role,
    atk: card.atk, hp: card.hp, maxHp: card.hp, armor: card.armor, ward: card.ward,
    mana: card.startMana, maxMana: card.maxMana, skill: card.skill, acts: card.type !== 'token',
    ready: false, taunt: false, frozen: false, burn: 0, thorns: 0, ...override,
  };
  if (s.cfg.terrain === 'mana' && s.terrain && s.terrain[lane] === u.element) u.mana = Math.min(u.maxMana, u.mana + 1);
  return u;
}

const atkPower = (s, u, lane) => u.atk + (s.cfg.terrain === 'atk' && s.terrain && s.terrain[lane] === u.element ? 1 : 0);

function tauntIn(s, lane, side) {
  for (let slot = 0; slot < 2; slot++) {
    const u = s.board[lane][side][slot];
    if (u && u.taunt) return slot;
  }
  return -1;
}

function kill(s, lane, side, slot) {
  const u = s.board[lane][side][slot];
  s.board[lane][side][slot] = null;
  if (u.acts) s.players[side].grave.push(u.id);
  emit(s, { type: 'Death', uid: u.uid, id: u.id, lane, side, slot });
}

// kind: physical (Armor), magic (Ward) or pure (nothing reduces it)
function hit(s, srcElement, lane, side, slot, power, kind, src) {
  const u = s.board[lane][side][slot];
  if (!u) return 0;
  const def = kind === 'physical' ? u.armor : kind === 'magic' ? u.ward : 0;
  const dmg = kind === 'pure' ? power : Math.max(1, power + elemModCfg(s, srcElement, u.element) - def);
  u.hp -= dmg;
  emit(s, { type: 'Damage', uid: u.uid, lane, side, slot, dmg, kind, src });
  if (u.hp <= 0) kill(s, lane, side, slot);
  return dmg;
}

function heal(s, u, n) {
  const before = u.hp;
  u.hp = Math.min(u.maxHp, u.hp + n);
  if (u.hp > before) emit(s, { type: 'Heal', uid: u.uid, amount: u.hp - before });
}

function hitShrine(s, side, lane, power, src) {
  const pl = s.players[side];
  if (pl.shrines[lane] <= 0 || s.closed[lane]) return 0;
  const dmg = Math.min(pl.shrines[lane], power);
  pl.shrines[lane] -= dmg;
  emit(s, { type: 'ShrineHit', side, lane, dmg, src });
  if (pl.shrines[lane] === 0) {
    emit(s, { type: 'ShrineDown', side, lane });
    if (s.cfg.comeback) for (const [u] of units(s, side)) u.mana = Math.min(u.maxMana, u.mana + 1);
    if (pl.shrines.filter((h) => h <= 0).length >= 2) finish(s, 1 - side, 'shrines');
    if (s.phase !== 'over') closeLane(s, lane, side);
  }
  return dmg;
}

// every unit leaves the closed lane: to a free slot of its own row in the nearest open lane of its side
// (ties to the lower lane), else back to its owner's hand as a fresh card, else it is lost to the graveyard.
// Tokens never go to hand. A relocated unit keeps damage, Mana and statuses except Burn (Lava Pool belongs
// to the lane) and, like a moved unit, does not act this turn.
function closeLane(s, lane, side) {
  s.closed[lane] = true;
  emit(s, { type: 'LaneClosed', lane, side });
  const gone = new Set();
  for (const p of [side, 1 - side])
    for (let from = 0; from < 2; from++) {
      const u = s.board[lane][p][from];
      if (!u) continue;
      s.board[lane][p][from] = null;
      gone.add(u.uid);
      const slot = slotFor(u.role);
      const to = [0, 1, 2].filter((l) => !s.closed[l] && !s.board[l][p][slot]).sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane) || a - b)[0];
      if (to !== undefined) {
        s.board[to][p][slot] = u;
        u.burn = 0;
        u.ready = false;
        emit(s, { type: 'Relocate', uid: u.uid, p, fromLane: lane, toLane: to, slot });
        continue;
      }
      const pl = s.players[p], lost = !u.acts || pl.hand.length >= s.cfg.handLimit;
      if (!lost) pl.hand.push(u.id);
      else if (u.acts) pl.grave.push(u.id);
      emit(s, { type: 'Recall', uid: u.uid, p, id: u.id, lost });
    }
  s.queue = s.queue.filter((uid) => !gone.has(uid));
}

function finish(s, winner, reason) {
  s.winner = winner;
  s.endReason = reason;
  s.phase = 'over';
  s.queue = [];
  emit(s, { type: 'GameOver', winner, reason });
}

// ---------- turn flow ----------

function startTurn(s, p) {
  s.active = p;
  s.phase = 'main';
  s.turn[p]++;
  const pl = s.players[p];
  pl.essence = Math.min(s.turn[p], s.cfg.maxEssence);
  pl.moved = false;
  if (p === 0 && s.turn[0] === 5) s.snap5 = [0, 1].map((q) => s.players[q].shrines.reduce((a, b) => a + b, 0));
  emit(s, { type: 'TurnStart', p, turn: s.turn[p], essence: pl.essence });
  draw(s, p);
  for (const [u, lane, slot] of [...units(s, p)]) {
    if (u.burn > 0) {
      u.burn--;
      hit(s, null, lane, p, slot, 1, 'pure', 'burn');
      if (!s.board[lane][p][slot]) continue;
    }
    if (u.maxMana > 0) {
      s.stats.manaGain[p]++;
      if (u.mana >= u.maxMana) s.stats.manaWasted[p]++;
      u.mana = Math.min(u.maxMana, u.mana + 1);
    }
    u.ready = true;
    u.taunt = false;
  }
  emit(s, { type: 'ManaGain', p });
}

function endTurn(s) {
  const p = s.active;
  emit(s, { type: 'TurnEnd', p });
  if (p === 1 && s.turn[1] >= s.cfg.turnLimit) {
    const total = (q) => s.players[q].shrines.reduce((a, b) => a + b, 0);
    const a = total(0), b = total(1);
    finish(s, a > b ? 0 : b > a ? 1 : 'draw', 'turnLimit');
    return;
  }
  startTurn(s, 1 - p);
}

function beginCombat(s) {
  s.phase = 'combat';
  s.queue = [];
  const p = s.active;
  for (let lane = 0; lane < 3; lane++)
    for (let slot = 0; slot < 2; slot++) {
      const u = s.board[lane][p][slot];
      if (!u || !u.acts || !u.ready) continue;
      if (u.frozen) { u.frozen = false; emit(s, { type: 'Thaw', uid: u.uid }); continue; }
      s.queue.push(u.uid);
    }
  settleQueue(s);
}

// drop dead actors from the head of the queue; end the turn when it is empty
function settleQueue(s) {
  while (s.phase === 'combat' && s.queue.length && !findUnit(s, s.queue[0])) s.queue.shift();
  if (s.phase === 'combat' && !s.queue.length) endTurn(s);
}

export const currentActor = (s) => (s.phase === 'combat' && s.queue.length ? findUnit(s, s.queue[0]) : null);

// ---------- legal actions ----------

function enemyTargets(s, lane, side) {
  const out = [];
  for (let slot = 0; slot < 2; slot++) if (s.board[lane][side][slot]) out.push({ lane, slot });
  return out;
}

function skillOptions(s, u, lane, side) {
  const sk = u.skill;
  if (!sk) return [];
  const foe = 1 - side;
  const cost = sk.cost === 'X' ? 1 : sk.cost;
  if (u.mana < cost) return [];
  const tauntSlot = tauntIn(s, lane, foe);
  const forced = tauntSlot >= 0 ? [{ lane, slot: tauntSlot }] : null;
  switch (sk.id) {
    case 'taunt': return [{ t: 'act', mode: 'skill' }];
    case 'dive': {
      // Dive needs an enemy Back unit; with diveFallback it hits the Front unit when the Back slot is empty
      const slot = s.board[lane][foe][BACK_SLOT] ? BACK_SLOT : s.cfg.diveFallback && s.board[lane][foe][FRONT_SLOT] ? FRONT_SLOT : -1;
      return slot < 0 ? [] : [{ t: 'act', mode: 'skill', target: forced ? forced[0] : { lane, slot } }];
    }
    case 'blast': return enemyTargets(s, lane, foe).length ? [{ t: 'act', mode: 'skill' }] : [];
    case 'snipe':
    case 'siphon': return (forced || enemyTargets(s, lane, foe)).map((target) => ({ t: 'act', mode: 'skill', target }));
    default: return [];
  }
}

export function legalActions(s) {
  if (s.phase === 'over') return [];
  const me = s.active, foe = 1 - me, pl = s.players[me];
  if (s.phase === 'combat') {
    const found = currentActor(s);
    if (!found) return [];
    const [u, lane] = found;
    return [{ t: 'act', mode: 'attack' }, ...skillOptions(s, u, lane, me)];
  }
  const acts = [{ t: 'end' }];
  const seen = new Set();
  for (const id of pl.hand) {
    if (seen.has(id)) continue;
    seen.add(id);
    const c = s.db[id];
    if (!c || c.cost > pl.essence) continue;
    if (s.cfg.noSpells && c.type === 'spell') continue;
    if (c.type === 'unit') {
      const slot = slotFor(c.role);
      for (let lane = 0; lane < 3; lane++) if (!s.closed[lane] && !s.board[lane][me][slot]) acts.push({ t: 'play', id, lane });
      continue;
    }
    for (const a of cardTargets(s, c, me, foe)) acts.push({ t: 'play', id, ...a });
  }
  if (!pl.moved && pl.essence >= s.cfg.moveCost)
    for (const [, lane, slot] of units(s, me))
      for (const to of [lane - 1, lane + 1])
        if (isOpen(s, to) && !s.board[to][me][slot]) acts.push({ t: 'move', lane, slot, to });
  return acts;
}

function cardTargets(s, c, me, foe) {
  const out = [];
  const allEnemies = () => { for (const [, lane, slot] of units(s, foe)) out.push({ target: { lane, slot } }); };
  const allAllies = () => { for (const [u, lane, slot] of units(s, me)) if (u.acts) out.push({ target: { lane, slot } }); };
  switch (c.id) {
    case 'fireball': case 'chain_lightning': case 'void_bolt': allEnemies(); break;
    case 'gust':
      for (const [, lane, slot] of units(s, foe))
        for (const to of [lane - 1, lane + 1]) if (isOpen(s, to) && !s.board[to][foe][slot]) out.push({ target: { lane, slot }, to });
      break;
    case 'lava_pool': case 'frost_nova':
      for (let lane = 0; lane < 3; lane++) if (!s.closed[lane] && enemyTargets(s, lane, foe).length) out.push({ lane });
      break;
    case 'gravity_well':
      for (let lane = 0; lane < 3; lane++) if (!s.closed[lane] && s.board[lane][foe][BACK_SLOT]) out.push({ lane });
      break;
    case 'thorns': case 'regrowth': allAllies(); break;
    case 'crystal_wall':
      for (let lane = 0; lane < 3; lane++) if (!s.closed[lane] && !s.board[lane][me][FRONT_SLOT]) out.push({ lane });
      break;
    case 'spark': case 'rebirth':
      if (c.id === 'spark' || s.players[me].grave.some((id) => s.db[id]?.type === 'unit')) out.push({});
      break;
    case 'mirror':
      for (const [u, lane, slot] of units(s, me))
        if (u.acts) for (const element of ELEMENTS) if (element !== u.element) out.push({ target: { lane, slot }, element });
      break;
    case 'swap':
      for (let slot = 0; slot < 2; slot++)
        for (let a = 0; a < 3; a++)
          for (let b = a + 1; b < 3; b++)
            if (s.board[a][me][slot] && s.board[b][me][slot]) out.push({ slot, lanes: [a, b] });
      break;
    case 'mimic':
      if (s.lastUnit) {
        const slot = slotFor(s.db[s.lastUnit].role);
        for (let lane = 0; lane < 3; lane++) if (!s.closed[lane] && !s.board[lane][me][slot]) out.push({ lane });
      }
      break;
  }
  return out;
}

// ---------- apply ----------

export function apply(s, a) {
  if (s.phase === 'over') throw new Error('game is over');
  const me = s.active, foe = 1 - me, pl = s.players[me];
  if (a.t === 'end') {
    if (s.phase !== 'main') throw new Error('end outside main');
    emit(s, { type: 'MainEnd', p: me });
    beginCombat(s);
    return s;
  }
  if (a.t === 'move') {
    if (!isOpen(s, a.to)) throw new Error('lane closed');
    const u = s.board[a.lane][me][a.slot];
    pl.essence -= s.cfg.moveCost;
    pl.moved = true;
    s.board[a.lane][me][a.slot] = null;
    s.board[a.to][me][a.slot] = u;
    u.ready = false;
    emit(s, { type: 'Move', uid: u.uid, from: a.lane, to: a.to, slot: a.slot });
    return s;
  }
  if (a.t === 'play') {
    for (const l of [a.lane, a.to]) if (l !== undefined && !isOpen(s, l)) throw new Error('lane closed');
    const c = s.db[a.id];
    // in a hidden hand the card is one of the unseen ones
    const at = pl.hand.indexOf(a.id);
    pl.hand.splice(at >= 0 ? at : pl.hand.indexOf(HIDDEN), 1);
    pl.essence -= c.cost;
    pl.played.push(a.id);
    if (c.type === 'unit') {
      const slot = slotFor(c.role);
      const u = makeUnit(s, c, me, a.lane);
      s.board[a.lane][me][slot] = u;
      s.lastUnit = c.id;
      emit(s, { type: 'Summon', uid: u.uid, id: c.id, p: me, lane: a.lane, slot });
    } else {
      emit(s, { type: c.type === 'joker' ? 'JokerReveal' : 'SpellCast', id: c.id, p: me, ...a });
      castCard(s, c, a, me, foe);
      if (c.type !== 'token') pl.grave.push(c.id);
    }
    return s;
  }
  if (a.t === 'act') {
    const found = currentActor(s);
    if (!found) throw new Error('no actor');
    const [u, lane, side] = found;
    s.queue.shift();
    if (a.mode === 'attack') attack(s, u, lane, side);
    else useSkill(s, u, lane, side, a);
    settleQueue(s);
    return s;
  }
  throw new Error(`unknown action ${a.t}`);
}

function attack(s, u, lane, side) {
  const foe = 1 - side;
  s.stats.attacks[side]++;
  emit(s, { type: 'Attack', uid: u.uid, lane });
  const power = atkPower(s, u, lane);
  const front = s.board[lane][foe][FRONT_SLOT];
  if (front) {
    const thorns = front.thorns;
    hit(s, u.element, lane, foe, FRONT_SLOT, power, 'physical', u.uid);
    if (thorns > 0) {
      const at = findUnit(s, u.uid);
      if (at) hit(s, null, at[1], at[2], at[3], thorns, 'pure', 'thorns');
    }
  } else {
    hitShrine(s, foe, lane, power, u.uid);
  }
}

function useSkill(s, u, lane, side, a) {
  const sk = u.skill, foe = 1 - side;
  s.stats.skills[side]++;
  const spent = sk.cost === 'X' ? u.mana : sk.cost;
  u.mana -= spent;
  emit(s, { type: 'Cast', uid: u.uid, skill: sk.id, manaSpent: spent, lane });
  switch (sk.id) {
    case 'taunt':
      u.taunt = true;
      emit(s, { type: 'Status', kind: 'taunt', uid: u.uid });
      break;
    case 'dive':
      hit(s, u.element, lane, foe, a.target.slot, sk.power, 'physical', u.uid);
      break;
    case 'blast':
      for (const slot of [FRONT_SLOT, BACK_SLOT]) hit(s, u.element, lane, foe, slot, spent * sk.power, 'magic', u.uid);
      break;
    case 'snipe':
      hit(s, u.element, lane, foe, a.target.slot, sk.power, 'physical', u.uid);
      break;
    case 'siphon': {
      hit(s, u.element, lane, foe, a.target.slot, sk.power, 'magic', u.uid);
      const ally = s.board[lane][side][FRONT_SLOT];
      if (ally && ally !== u) heal(s, ally, sk.heal);
      break;
    }
  }
}

function castCard(s, c, a, me, foe) {
  const t = a.target;
  switch (c.id) {
    case 'fireball': hit(s, c.element, t.lane, foe, t.slot, 3, 'magic', c.id); break;
    case 'lava_pool':
      for (let slot = 0; slot < 2; slot++) { const u = s.board[a.lane][foe][slot]; if (u) u.burn = 2; }
      break;
    case 'thorns': s.board[t.lane][me][t.slot].thorns += 1; break;
    case 'regrowth': {
      const u = s.board[t.lane][me][t.slot];
      heal(s, u, 1);
      u.atk += 1; u.maxHp += 1; u.hp += 1;
      break;
    }
    case 'chain_lightning': {
      const victim = s.board[t.lane][foe][t.slot];
      hit(s, c.element, t.lane, foe, t.slot, 2, 'magic', c.id);
      if (victim && !findUnit(s, victim.uid)) {
        for (const lane of [t.lane - 1, t.lane + 1]) {
          if (lane < 0 || lane > 2) continue;
          const slot = s.board[lane][foe][FRONT_SLOT] ? FRONT_SLOT : s.board[lane][foe][BACK_SLOT] ? BACK_SLOT : -1;
          if (slot >= 0) { hit(s, c.element, lane, foe, slot, 2, 'magic', c.id); break; }
        }
      }
      break;
    }
    case 'gust': {
      const u = s.board[t.lane][foe][t.slot];
      s.board[t.lane][foe][t.slot] = null;
      s.board[a.to][foe][t.slot] = u;
      break;
    }
    case 'frost_nova':
      for (let slot = 0; slot < 2; slot++) { const u = s.board[a.lane][foe][slot]; if (u) u.frozen = true; }
      break;
    case 'crystal_wall': {
      const u = makeUnit(s, s.db.crystal_wall_token, me, a.lane);
      s.board[a.lane][me][FRONT_SLOT] = u;
      emit(s, { type: 'Summon', uid: u.uid, id: u.id, p: me, lane: a.lane, slot: FRONT_SLOT });
      break;
    }
    case 'void_bolt': {
      const dealt = hit(s, c.element, t.lane, foe, t.slot, 2, 'magic', c.id);
      const ally = s.board[t.lane][me][FRONT_SLOT] || s.board[t.lane][me][BACK_SLOT];
      if (ally && ally.acts) heal(s, ally, dealt);
      break;
    }
    case 'gravity_well': {
      const lane = s.board[a.lane][foe];
      [lane[FRONT_SLOT], lane[BACK_SLOT]] = [lane[BACK_SLOT], lane[FRONT_SLOT]];
      for (const slot of [FRONT_SLOT, BACK_SLOT]) hit(s, c.element, a.lane, foe, slot, 1, 'magic', c.id);
      break;
    }
    case 'spark': s.players[me].essence += 1; break;
    case 'mirror': s.board[t.lane][me][t.slot].element = a.element; break;
    case 'swap': {
      const [x, y] = a.lanes;
      const row = (lane) => s.board[lane][me];
      [row(x)[a.slot], row(y)[a.slot]] = [row(y)[a.slot], row(x)[a.slot]];
      break;
    }
    case 'mimic': {
      const src = s.db[s.lastUnit];
      const slot = slotFor(src.role);
      const u = makeUnit(s, src, me, a.lane, { atk: Math.max(1, src.atk - 1), hp: Math.max(1, src.hp - 1), maxHp: Math.max(1, src.hp - 1) });
      s.board[a.lane][me][slot] = u;
      emit(s, { type: 'Summon', uid: u.uid, id: src.id, p: me, lane: a.lane, slot, mimic: true });
      break;
    }
    case 'rebirth': {
      const g = s.players[me].grave;
      let best = -1;
      // a bot's look ahead on a hidden state can burn an unseen card, so a grave may hold one
      g.forEach((id, i) => { if (s.db[id]?.type === 'unit' && (best < 0 || s.db[id].cost > s.db[g[best]].cost)) best = i; });
      if (best >= 0) s.players[me].hand.push(g.splice(best, 1)[0]);
      break;
    }
  }
}
