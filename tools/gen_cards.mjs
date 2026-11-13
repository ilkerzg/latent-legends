// Builds data/cards.json: 25 characters (element x role), 10 spells, 5 jokers.
// Character stats come from per-role tables by Essence cost; costs follow a Latin square
// so every element has one character at each cost 1..5 and every role appears at each cost once.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ELEMENTS = ['Fire', 'Wild', 'Storm', 'Frost', 'Shadow'];
const ROLES = ['Tank', 'Fighter', 'Mage', 'Archer', 'Support'];

const NAMES = {
  Fire: ['Ember Warden', 'Cinder Raider', 'Pyre Sage', 'Flare Archer', 'Hearth Keeper'],
  Wild: ['Barkhide', 'Thorn Stalker', 'Grove Shaman', 'Briar Slinger', 'Bloom Tender'],
  Storm: ['Thunder Bulwark', 'Gale Duelist', 'Tempest Caller', 'Spark Archer', 'Squall Mender'],
  Frost: ['Glacier Shield', 'Frost Reaver', 'Rime Witch', 'Icicle Sniper', 'Snow Lantern'],
  Shadow: ['Gloom Sentinel', 'Night Blade', 'Void Weaver', 'Umbral Hunter', 'Dusk Oracle'],
};

// cost -> [atk, hp, armor, ward, startMana, maxMana, skill power, skill heal]
const TABLE = {
  Tank: { 1: [1, 3, 1, 0, 0, 2, 1], 2: [1, 4, 2, 0, 1, 2, 1], 3: [2, 5, 3, 0, 1, 2, 1], 4: [2, 8, 3, 0, 1, 2, 1], 5: [2, 10, 4, 0, 1, 2, 1] },
  Fighter: { 1: [2, 2, 0, 0, 0, 2, 3], 2: [3, 3, 0, 0, 0, 2, 4], 3: [4, 5, 0, 0, 0, 2, 5], 4: [5, 7, 0, 0, 0, 2, 6], 5: [6, 8, 0, 0, 0, 2, 7] },
  Mage: { 1: [1, 2, 0, 0, 0, 1, 1], 2: [1, 5, 0, 0, 1, 2, 1], 3: [2, 4, 0, 0, 3, 4, 1], 4: [2, 6, 0, 0, 4, 5, 1], 5: [3, 8, 0, 0, 5, 6, 1] },
  Archer: { 1: [1, 2, 1, 0, 0, 2, 2], 2: [2, 2, 1, 0, 1, 2, 3], 3: [3, 5, 1, 0, 1, 2, 4], 4: [5, 5, 1, 0, 1, 2, 6], 5: [5, 9, 1, 0, 1, 2, 7] },
  Support: { 1: [2, 2, 0, 1, 0, 2, 1, 1], 2: [1, 3, 0, 2, 2, 4, 1, 1], 3: [1, 6, 0, 2, 2, 4, 2, 2], 4: [2, 8, 0, 2, 2, 4, 3, 3], 5: [3, 8, 0, 2, 2, 4, 5, 5] },
};

const SKILLS = {
  Tank: (p) => ({ id: 'taunt', cost: 2, power: p[6], text: '[2] Taunt: until your next turn, enemy Dive, Snipe and Siphon in this lane must target this unit.' }),
  Fighter: (p) => ({ id: 'dive', cost: 2, power: p[6], text: `[2] Dive: ${p[6]} physical to the enemy Back unit in this lane, or to the Front unit if the Back slot is empty.` }),
  Mage: () => ({ id: 'blast', cost: 'X', power: 1, text: '[X] Blast: spend all Mana; that much magic to every enemy unit in this lane.' }),
  Archer: (p) => ({ id: 'snipe', cost: 2, power: p[6], text: `[2] Snipe: ${p[6]} physical to any enemy unit in this lane.` }),
  Support: (p) => ({ id: 'siphon', cost: 2, power: p[6], heal: p[7], text: `[2] Siphon: ${p[6]} magic to an enemy unit in this lane, heal your Front unit here ${p[7]}.` }),
};

// per-card corrections found by sim/tune.mjs, on top of the role tables (lint allows up to 3 points)
const tuningFile = new URL('../data/tuning.json', import.meta.url);
const tuning = existsSync(tuningFile) ? JSON.parse(readFileSync(tuningFile)) : {};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const costOf = (e, r) => 1 + ((r + 2 * e + 1) % 5);

const cards = [];
ELEMENTS.forEach((element, e) => {
  ROLES.forEach((role, r) => {
    const cost = costOf(e, r);
    const p = TABLE[role][cost];
    const name = NAMES[element][r];
    const id = slug(name);
    const t = tuning[id] || {};
    cards.push({
      id, name, type: 'unit', element, role, cost,
      atk: p[0] + (t.atk || 0), hp: p[1] + (t.hp || 0), armor: p[2], ward: p[3], startMana: p[4], maxMana: p[5],
      skill: SKILLS[role](p),
      ...(t.atk || t.hp ? { tuned: { atk: t.atk || 0, hp: t.hp || 0 } } : {}),
    });
  });
});

const spell = (id, name, element, cost, target, text) => ({ id, name, type: 'spell', element, cost, target, text });
cards.push(
  spell('fireball', 'Fireball', 'Fire', 3, 'enemyUnit', '3 magic to any enemy unit.'),
  spell('lava_pool', 'Lava Pool', 'Fire', 2, 'lane', 'Enemy units in a lane burn for 1 at the start of their next 2 turns.'),
  spell('thorns', 'Thorns', 'Wild', 1, 'allyUnit', 'An ally gains Thorns 1: every Attack against it deals 1 back.'),
  spell('regrowth', 'Regrowth', 'Wild', 2, 'allyUnit', 'Heal an ally 1 and give it +1/+1.'),
  spell('chain_lightning', 'Chain Lightning', 'Storm', 3, 'enemyUnit', '2 magic to an enemy unit. If it dies, 2 magic to an enemy unit in an adjacent lane.'),
  spell('gust', 'Gust', 'Storm', 4, 'enemyUnit', 'Push an enemy unit to the same row of an adjacent lane, if that slot is empty.'),
  spell('frost_nova', 'Frost Nova', 'Frost', 3, 'lane', 'Freeze every enemy unit in a lane: each skips its next action.'),
  spell('crystal_wall', 'Crystal Wall', 'Frost', 1, 'ownFrontSlot', 'Summon a 0/4 Crystal Wall with Armor 1 in your empty Front slot. It never acts.'),
  spell('void_bolt', 'Void Bolt', 'Shadow', 2, 'enemyUnit', '2 magic to an enemy unit. Heal your unit in that lane by the damage dealt.'),
  spell('gravity_well', 'Gravity Well', 'Shadow', 3, 'lane', 'Swap the enemy Front and Back units in a lane, then deal 1 magic to both.'),
);
const joker = (id, name, cost, target, text) => ({ id, name, type: 'joker', element: null, cost, target, text });
cards.push(
  joker('spark', 'Spark', 0, 'none', '+1 Essence this turn.'),
  joker('mirror', 'Mirror', 2, 'allyUnit', "Change an ally's element for the rest of the match."),
  joker('swap', 'Swap', 0, 'allyPair', 'Swap two of your units in the same row, across lanes.'),
  joker('mimic', 'Mimic', 2, 'ownSlot', 'Summon a -1/-1 copy of the last character played by either player.'),
  joker('rebirth', 'Rebirth', 2, 'none', 'Return your most expensive fallen character to your hand.'),
);
cards.push({ id: 'crystal_wall_token', name: 'Crystal Wall', type: 'token', element: 'Frost', role: 'Wall', cost: 0, atk: 0, hp: 4, armor: 1, ward: 0, startMana: 0, maxMana: 0, skill: null });

const out = fileURLToPath(new URL('../data/cards.json', import.meta.url));
writeFileSync(out, JSON.stringify({ version: '0.2', cards }, null, 1));
console.log(`wrote ${cards.length} cards to data/cards.json`);
