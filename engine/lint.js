// Card lint: the cost budget formula and the locked role identities.
// Run: node engine/lint.js   (exit code 1 on any error)

export const budget = (cost) => 4 * cost + 3;

export function skillPoints(skill) {
  if (!skill) return 0;
  const cost = skill.cost === 'X' ? 1 : skill.cost;
  let power;
  switch (skill.id) {
    case 'taunt': power = skill.power; break;
    case 'dive': power = skill.power; break;
    case 'blast': power = skill.power * 2; break; // every enemy in the lane
    case 'snipe': power = skill.power + 1; break; // any target
    case 'siphon': power = skill.power + 1 + 0.5 * skill.heal; break; // healing is often partly wasted
    default: throw new Error(`unknown skill ${skill.id}`);
  }
  return (power * 2) / cost;
}

// HP is priced by row: Front HP 1.2, because a Front unit soaks every Attack in its lane and
// shields the Shrine; Back HP 0.8, because only Skills and spells ever reach the Back row
export const hpWeight = (role) => (role === 'Tank' || role === 'Fighter' ? 1.2 : 0.8);

export function points(c) {
  const skillCost = c.skill.cost === 'X' ? 1 : c.skill.cost;
  return c.atk + hpWeight(c.role) * c.hp + 1.5 * c.armor + 0.5 * c.ward + 1.5 * c.startMana
    + 0.5 * Math.max(0, c.maxMana - skillCost) + skillPoints(c.skill);
}

export function lint(cards) {
  const errors = [], warnings = [], rows = [];
  const ids = new Set();
  for (const c of cards) {
    if (ids.has(c.id)) errors.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (c.type !== 'unit') continue;
    // the role tables must hit the budget; a tuned card may sit up to 3 points off it
    const t = c.tuned || { atk: 0, hp: 0 };
    const p = points(c), base = points({ ...c, atk: c.atk - t.atk, hp: c.hp - t.hp }), b = budget(c.cost);
    rows.push({ id: c.id, element: c.element, role: c.role, cost: c.cost, points: Math.round(p * 10) / 10, budget: b, tuned: Math.round((p - base) * 10) / 10 });
    if (Math.abs(base - b) > 0.5) errors.push(`${c.id}: table gives ${base} points, budget ${b}`);
    if (Math.abs(p - base) > 3) errors.push(`${c.id}: tuning moves it ${p - base} points, limit 3`);
    if (c.atk < 1) errors.push(`${c.id}: ATK below 1`);
    if (c.startMana > c.maxMana - 1) errors.push(`${c.id}: Start Mana must be at most Max Mana - 1`);
    const id = (msg) => errors.push(`${c.id}: role identity: ${msg}`);
    if (c.role === 'Tank' && c.ward !== 0) id('Tank Ward must be 0');
    if (c.role === 'Fighter' && (c.armor || c.ward)) id('Fighter has no defence');
    if (c.role === 'Archer' && (c.armor !== 1 || c.ward)) id('Archer is Armor 1, Ward 0');
    if (c.role === 'Support' && (c.armor || c.ward < 1)) id('Support is Armor 0, Ward 1 or more');
    if (c.role === 'Mage' && c.startMana !== c.maxMana - 1) id('Mage Start Mana is Max Mana - 1');
  }
  const units = cards.filter((c) => c.type === 'unit');
  for (let cost = 1; cost <= 5; cost++) {
    const at = (role) => units.find((c) => c.cost === cost && c.role === role);
    const tank = at('Tank');
    if (tank) for (const c of units.filter((u) => u.cost === cost)) if (c.armor > tank.armor) errors.push(`${c.id}: Armor above the Tank at cost ${cost}`);
    const fighter = at('Fighter');
    for (const role of ['Mage', 'Support']) {
      const back = at(role);
      if (fighter && back && fighter.skill.power < back.hp) warnings.push(`cost ${cost}: Dive ${fighter.skill.power} below ${role} HP ${back.hp}`);
    }
  }
  const count = (t) => cards.filter((c) => c.type === t).length;
  if (count('unit') !== 25 || count('spell') !== 10 || count('joker') !== 5) errors.push(`set size: ${count('unit')} units, ${count('spell')} spells, ${count('joker')} jokers`);
  return { errors, warnings, rows };
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  const { cards } = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
  const { errors, warnings, rows } = lint(cards);
  for (const r of rows.sort((a, b) => a.cost - b.cost || a.role.localeCompare(b.role))) {
    console.log(`${String(r.cost).padStart(2)}  ${r.role.padEnd(8)} ${r.element.padEnd(7)} ${r.id.padEnd(16)} ${String(r.points).padStart(5)} / ${r.budget}${r.tuned ? `   tuned ${r.tuned > 0 ? '+' : ''}${r.tuned}` : ''}`);
  }
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`ERROR: ${e}`);
  console.log(errors.length ? `${errors.length} errors` : `lint ok: ${rows.length} characters, ${warnings.length} warnings`);
  process.exit(errors.length ? 1 : 0);
}
