// Deck rules shared by the deck builder (web), the bots and the room server. Pure data, no DOM.

// every card a deck may hold: 25 characters (5 elements x 5 roles), 10 spells and 5 jokers
export const POOL = [
  'ember_warden', 'cinder_raider', 'pyre_sage', 'flare_archer', 'hearth_keeper',
  'barkhide', 'thorn_stalker', 'grove_shaman', 'briar_slinger', 'bloom_tender',
  'thunder_bulwark', 'gale_duelist', 'tempest_caller', 'spark_archer', 'squall_mender',
  'glacier_shield', 'frost_reaver', 'rime_witch', 'icicle_sniper', 'snow_lantern',
  'gloom_sentinel', 'night_blade', 'void_weaver', 'umbral_hunter', 'dusk_oracle',
  'fireball', 'lava_pool', 'thorns', 'regrowth', 'chain_lightning', 'gust',
  'frost_nova', 'crystal_wall', 'void_bolt', 'gravity_well',
  'spark', 'mirror', 'swap', 'mimic', 'rebirth',
];
// the cards the builder and the card book mark NEW
export const NEW_CARDS = POOL.slice(5, 15).concat(POOL.slice(20, 25), ['thorns', 'regrowth', 'chain_lightning', 'gust', 'void_bolt', 'gravity_well', 'swap', 'mimic', 'rebirth']);

export const DECK_RULES = { size: 20, maxCopies: 2, minUnits: 8, maxJokers: 2 };

// ready decks: the bot picks from these, and a new player starts from one
export const STARTERS = {
  balanced: {
    name: 'Balanced', blurb: 'Fire and Frost, a bit of everything.',
    cards: ['ember_warden', 'cinder_raider', 'pyre_sage', 'flare_archer', 'hearth_keeper',
      'glacier_shield', 'frost_reaver', 'rime_witch', 'icicle_sniper', 'snow_lantern',
      'fireball', 'lava_pool', 'frost_nova', 'crystal_wall', 'spark', 'mirror',
      'ember_warden', 'glacier_shield', 'hearth_keeper', 'icicle_sniper'],
  },
  ember_rush: {
    name: 'Ember Rush', blurb: 'Cheap Fire units and burn. Break a Shrine early.',
    cards: ['ember_warden', 'ember_warden', 'cinder_raider', 'cinder_raider', 'pyre_sage', 'pyre_sage',
      'flare_archer', 'flare_archer', 'hearth_keeper', 'hearth_keeper', 'fireball', 'fireball',
      'lava_pool', 'lava_pool', 'spark', 'spark', 'frost_reaver', 'frost_reaver', 'icicle_sniper', 'icicle_sniper'],
  },
  frost_bastion: {
    name: 'Frost Bastion', blurb: 'Walls, freezes and patient Archers, with Shadow against Fire and Storm.',
    cards: ['glacier_shield', 'glacier_shield', 'frost_reaver', 'frost_reaver', 'rime_witch', 'rime_witch',
      'icicle_sniper', 'icicle_sniper', 'snow_lantern', 'snow_lantern', 'frost_nova', 'frost_nova',
      'crystal_wall', 'crystal_wall', 'night_blade', 'umbral_hunter', 'umbral_hunter', 'dusk_oracle', 'void_bolt', 'spark'],
  },
  storm_surge: {
    name: 'Storm Surge', blurb: 'Quick Storm units and chain lightning, with Fire for reach.',
    cards: ['thunder_bulwark', 'thunder_bulwark', 'gale_duelist', 'gale_duelist', 'tempest_caller', 'tempest_caller',
      'spark_archer', 'spark_archer', 'squall_mender', 'squall_mender', 'chain_lightning', 'chain_lightning', 'gust',
      'ember_warden', 'pyre_sage', 'flare_archer', 'hearth_keeper', 'lava_pool', 'swap', 'spark'],
  },
  shadow_veil: {
    name: 'Shadow Veil', blurb: 'Drain and pull with Shadow, burn with Fire.',
    cards: ['gloom_sentinel', 'night_blade', 'night_blade', 'void_weaver', 'void_weaver', 'umbral_hunter', 'umbral_hunter',
      'dusk_oracle', 'dusk_oracle', 'void_bolt', 'void_bolt', 'gravity_well', 'gravity_well',
      'ember_warden', 'ember_warden', 'cinder_raider', 'pyre_sage', 'lava_pool', 'rebirth', 'mirror'],
  },
  wild_grove: {
    name: 'Wild Grove', blurb: 'Tough Wild units that grow, with Storm for reach.',
    cards: ['barkhide', 'barkhide', 'thorn_stalker', 'grove_shaman', 'grove_shaman', 'briar_slinger', 'briar_slinger',
      'bloom_tender', 'bloom_tender', 'thorns', 'thorns', 'regrowth', 'regrowth',
      'thunder_bulwark', 'thunder_bulwark', 'gale_duelist', 'spark_archer', 'chain_lightning', 'mimic', 'spark'],
  },
};

export function deckStats(db, ids) {
  const curve = Array(9).fill(0);
  const out = { size: ids.length, units: 0, spells: 0, jokers: 0, curve, avgCost: 0, elements: {} };
  let sum = 0;
  for (const id of ids) {
    const c = db[id];
    if (!c) continue;
    if (c.type === 'unit') out.units++; else if (c.type === 'joker') out.jokers++; else out.spells++;
    const cost = typeof c.cost === 'number' ? c.cost : 0;
    curve[Math.min(8, cost)]++; sum += cost;
    const e = c.element ?? 'None';
    out.elements[e] = (out.elements[e] ?? 0) + 1;
  }
  out.avgCost = ids.length ? Math.round((sum / ids.length) * 10) / 10 : 0;
  return out;
}

// every reason a deck is not legal, in plain words for the builder
export function validateDeck(db, ids) {
  const errors = [];
  const R = DECK_RULES;
  if (!Array.isArray(ids)) return { ok: false, errors: ['No deck'] };
  if (ids.length !== R.size) errors.push(`A deck has exactly ${R.size} cards (this one has ${ids.length})`);
  const count = {};
  for (const id of ids) {
    if (!POOL.includes(id) || !db[id]) { errors.push(`Unknown card: ${id}`); continue; }
    count[id] = (count[id] ?? 0) + 1;
  }
  for (const [id, n] of Object.entries(count)) if (n > R.maxCopies) errors.push(`At most ${R.maxCopies} copies of ${db[id].name}`);
  const st = deckStats(db, ids);
  if (st.units < R.minUnits) errors.push(`At least ${R.minUnits} units (this one has ${st.units})`);
  if (st.jokers > R.maxJokers) errors.push(`At most ${R.maxJokers} jokers`);
  return { ok: errors.length === 0, errors };
}
