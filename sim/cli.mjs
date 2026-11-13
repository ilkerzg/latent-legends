// One bot match printed as text, event by event.
// node sim/cli.mjs [seed] [deck0] [deck1] [bot0] [bot1]    e.g. node sim/cli.mjs 7 Fire-Frost Storm-Shadow greedy greedy
// deck names: the element pairs of sim/game.js or a starter (balanced, ember_rush, frost_bastion); bots: greedy, random, easy, normal, hard
import { loadDb, buildDecks, playGame } from './game.js';
import { STARTERS } from '../engine/deck.js';
import { findUnit } from '../engine/rules.js';

const [seed = '7', d0 = 'Fire-Frost', d1 = 'Storm-Shadow', b0 = 'greedy', b1 = 'greedy'] = process.argv.slice(2);
const db = loadDb();
const decks = buildDecks(db);
const deck = (n) => decks.find((d) => d.name === n) || STARTERS[n] || (() => { throw new Error(`deck ${n}; have ${decks.map((d) => d.name).concat(Object.keys(STARTERS)).join(', ')}`); })();
const LANE = (l) => `L${l + 1}`;
const SLOT = ['Front', 'Back'];
const who = ['A', 'B'];
const name = (id) => db[id]?.name ?? id;

let lastLen = 0;
const s = playGame(db, deck(d0).cards, deck(d1).cards, Number(seed), [b0, b1], {
  log: true,
  onStep(st) {
    for (const e of st.events.slice(lastLen)) {
      const line = fmt(st, e);
      if (line) console.log(line);
    }
    lastLen = st.events.length;
  },
});
console.log(`\nShrines A: ${s.players[0].shrines.join('/')}   B: ${s.players[1].shrines.join('/')}`);
console.log(`Mana gained ${s.stats.manaGain.join('/')}, wasted ${s.stats.manaWasted.join('/')}, skills ${s.stats.skills.join('/')}, attacks ${s.stats.attacks.join('/')}`);

function fmt(st, e) {
  switch (e.type) {
    case 'TurnStart': return `\n== ${who[e.p]} turn ${e.turn}, Essence ${e.essence}  (A ${st.players[0].shrines.join('/')} | B ${st.players[1].shrines.join('/')})`;
    case 'Summon': return `  ${who[e.p]} plays ${name(e.id)}${e.mimic ? ' (Mimic copy)' : ''} -> ${LANE(e.lane)} ${SLOT[e.slot]}`;
    case 'SpellCast': case 'JokerReveal': return `  ${who[e.p]} casts ${name(e.id)}${e.target ? ` on ${LANE(e.target.lane)} ${SLOT[e.target.slot]}` : e.lane !== undefined ? ` on ${LANE(e.lane)}` : ''}`;
    case 'Move': return `  move ${LANE(e.from)} -> ${LANE(e.to)}`;
    case 'Attack': return `  Attack from ${LANE(e.lane)}`;
    case 'Cast': return `  Skill ${e.skill} (${e.manaSpent} Mana) in ${LANE(e.lane)}`;
    case 'Damage': return `    ${e.dmg} ${e.kind} -> ${LANE(e.lane)} ${SLOT[e.slot]}`;
    case 'Heal': return `    heal ${e.amount}`;
    case 'Status': return `    Taunt up`;
    case 'Death': return `    ${name(e.id)} dies`;
    case 'ShrineHit': return `    Shrine ${who[e.side]} ${LANE(e.lane)} -${e.dmg}`;
    case 'ShrineDown': return `    Shrine ${who[e.side]} ${LANE(e.lane)} DESTROYED`;
    case 'LaneClosed': return `    ${LANE(e.lane)} CLOSED (Shrine ${who[e.side]} fell)`;
    case 'Relocate': return `    ${who[e.p]} ${findUnit(st, e.uid)?.[0].name ?? 'unit'} #${e.uid} relocates ${LANE(e.fromLane)} -> ${LANE(e.toLane)} ${SLOT[e.slot]}`;
    case 'Recall': return `    ${who[e.p]} ${name(e.id)} #${e.uid} ${e.lost ? 'is lost (no room)' : 'returns to hand'}`;
    case 'Thaw': return `  a frozen unit skips its action`;
    case 'GameOver': return `\n### ${e.winner === 'draw' ? 'Draw' : `${who[e.winner]} wins`} (${e.reason})`;
    default: return null;
  }
}
