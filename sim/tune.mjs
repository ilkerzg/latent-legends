// Auto-tuner: plays the field, then moves the HP of the cards furthest from their cost tier by 1.
// Corrections go to data/tuning.json; tools/gen_cards.mjs applies them and lint caps them at 3 points.
// node sim/tune.mjs [iterations=8] [games per pair=200] [cards per step=5] [threshold=0.025]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [iters = 8, games = 200, perStep = 5, threshold = 0.025] = process.argv.slice(2).map(Number);
const root = new URL('../', import.meta.url);
const run = (cmd) => execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const tuningPath = new URL('data/tuning.json', root);
const tuning = existsSync(tuningPath) ? JSON.parse(readFileSync(tuningPath)) : {};

for (let it = 1; it <= iters; it++) {
  run('node tools/gen_cards.mjs');
  run(`node sim/run.mjs ${games} greedy,greedy --evolved --out=tune`);
  const { meta, results } = JSON.parse(readFileSync(new URL('out/balance/tune.json', root)));
  const { cards } = JSON.parse(readFileSync(new URL('data/cards.json', root)));
  const db = Object.fromEntries(cards.map((c) => [c.id, c]));
  const base = (i) => !meta.decks[i].joker;
  const st = {}, tier = {};
  for (const g of results) {
    if ((g.w !== 0 && g.w !== 1) || !base(g.a) || !base(g.b)) continue;
    for (const p of [0, 1]) for (const id of g.p[p]) {
      const win = g.w === p ? 1 : 0, c = db[id].cost;
      (st[id] ??= [0, 0])[0] += win; st[id][1]++;
      (tier[c] ??= [0, 0])[0] += win; tier[c][1]++;
    }
  }
  const rel = Object.entries(st).filter(([id]) => db[id].type === 'unit')
    .map(([id, [w, n]]) => ({ id, rel: w / n - tier[db[id].cost][0] / tier[db[id].cost][1] }))
    .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
  const worst = rel.filter((r) => Math.abs(r.rel) > threshold).slice(0, perStep);
  const moved = [];
  for (const { id, rel: r } of worst) {
    const c = db[id], t = (tuning[id] ??= { hp: 0 });
    const step = r > 0 ? -1 : 1;
    if (c.hp + step < 1 || Math.abs((t.hp || 0) + step) > (c.role === 'Tank' || c.role === 'Fighter' ? 2 : 3)) continue;
    t.hp = (t.hp || 0) + step;
    moved.push(`${c.name} ${(r * 100).toFixed(1)} -> hp ${step > 0 ? '+1' : '-1'}`);
  }
  writeFileSync(tuningPath, JSON.stringify(tuning, null, 1));
  console.log(`iteration ${it}: max |rel| ${(Math.abs(rel[0].rel) * 100).toFixed(1)}, ${moved.length ? moved.join('; ') : 'no change'}`);
  if (!moved.length) break;
}
run('node tools/gen_cards.mjs');
console.log(run('node engine/lint.js').split('\n').filter((l) => /ERROR|lint ok/.test(l)).join('\n'));
