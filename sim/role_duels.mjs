// Role wheel check on the real engine: at each cost, the two roles meet in one lane (elements off),
// each side with a 2 ATK / 5 HP vanilla partner in its other slot. First Shrine down wins. Both seat orders.
import { loadDb } from './game.js';
import { newGame, apply, ROLES, slotFor } from '../engine/rules.js';
import { greedy } from './bots/greedy.js';

const db = loadDb();
db.vanilla_front = { id: 'vanilla_front', name: 'Militia', type: 'unit', element: null, role: 'Tank', atk: 2, hp: 5, armor: 0, ward: 0, startMana: 0, maxMana: 0, skill: null };
db.vanilla_back = { id: 'vanilla_back', name: 'Bowman', type: 'unit', element: null, role: 'Archer', atk: 2, hp: 3, armor: 0, ward: 0, startMana: 0, maxMana: 0, skill: null };
const EDGES = [['Tank', 'Fighter'], ['Tank', 'Archer'], ['Fighter', 'Mage'], ['Fighter', 'Support'], ['Mage', 'Archer'], ['Mage', 'Tank'], ['Archer', 'Support'], ['Archer', 'Fighter'], ['Support', 'Tank'], ['Support', 'Mage']];
const card = (role, cost) => Object.values(db).find((c) => c.type === 'unit' && c.role === role && c.cost === cost);

function duel(a, b, first, partner) {
  const s = newGame(db, [[], []], 1, { noElements: true, secondPlayerSparks: 0, p1ShrineBonus: 0 });
  s.players.forEach((p) => { p.hand = []; p.shrines = [9, 0, 0]; });
  const place = (side, c) => {
    const slot = slotFor(c.role);
    s.board[0][side][slot] = { uid: ++s.uid, id: c.id, name: c.name, owner: side, element: null, role: c.role, atk: c.atk, hp: c.hp, maxHp: c.hp, armor: c.armor, ward: c.ward, mana: c.startMana, maxMana: c.maxMana, skill: c.skill, acts: true, ready: true, taunt: false, frozen: false, burn: 0, thorns: 0 };
    if (partner) {
      const v = slot === 0 ? db.vanilla_back : db.vanilla_front;
      s.board[0][side][1 - slot] = { uid: ++s.uid, id: v.id, name: v.name, owner: side, element: null, role: v.role, atk: v.atk, hp: v.hp, maxHp: v.hp, armor: 0, ward: 0, mana: 0, maxMana: 0, skill: null, acts: true, ready: true, taunt: false, frozen: false, burn: 0, thorns: 0 };
    }
  };
  const [p0, p1] = first === 0 ? [a, b] : [b, a];
  place(0, p0); place(1, p1);
  s.active = 0;
  while (s.phase !== 'over') apply(s, greedy(s));
  const winner = s.winner === 'draw' ? null : s.winner;
  return winner === null ? null : (first === 0 ? winner === 0 : winner === 1);
}

for (const partner of [false, true]) {
  console.log(partner ? '\nLane skirmish (each side has a vanilla partner):' : '1v1 duels:');
  let held = 0;
  for (const [w, l] of EDGES) {
    const res = [];
    for (let cost = 1; cost <= 5; cost++) for (const first of [0, 1]) res.push(duel(card(w, cost), card(l, cost), first, partner));
    const dec = res.filter((r) => r !== null), wins = dec.filter(Boolean).length;
    const ok = dec.length && wins / dec.length >= 0.55;
    if (ok) held++;
    console.log(`  ${w.padEnd(8)} > ${l.padEnd(8)} ${wins}/${dec.length} ${ok ? 'holds' : 'BROKEN'}`);
  }
  console.log(`  ${held}/10 edges hold`);
}
