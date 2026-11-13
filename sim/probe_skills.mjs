// How often each role uses its Skill when it could, and why Mana is wasted. Diagnostic only.
import { loadDb, buildDecks } from './game.js';
import { newGame, apply, legalActions, currentActor } from '../engine/rules.js';
import { BOTS } from './bots/greedy.js';
const db = loadDb(), decks = buildDecks(db).filter((d) => !d.joker);
const opts = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : isNaN(+v) ? v : +v]));
const st = {};
for (let seed = 1; seed <= 600; seed++) {
  const s = newGame(db, [decks[seed % 10].cards, decks[(seed * 7) % 10].cards], seed, opts);
  while (s.phase !== 'over') {
    if (s.phase === 'combat') {
      const [u] = currentActor(s);
      const acts = legalActions(s);
      const r = (st[u.role] ??= { turns: 0, canSkill: 0, used: 0, full: 0 });
      r.turns++;
      if (u.mana >= u.maxMana) r.full++;
      if (acts.length > 1) r.canSkill++;
      const a = BOTS.greedy(s);
      if (a.mode === 'skill') r.used++;
      apply(s, a);
    } else apply(s, BOTS.greedy(s));
  }
}
for (const [role, r] of Object.entries(st)) console.log(role.padEnd(8), `actions ${r.turns}, skill legal ${(r.canSkill / r.turns * 100).toFixed(0)}%, used when legal ${(r.used / Math.max(1, r.canSkill) * 100).toFixed(0)}%, bar full ${(r.full / r.turns * 100).toFixed(0)}%`);
