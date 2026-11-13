// Balance report: reads out/balance/<name>.json, prints the gates and writes out/balance/<name>.html.
// node sim/report.mjs [name] [random-vs-greedy name]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadDb } from './game.js';

const name = process.argv[2] || 'results';
const sanityName = process.argv[3];
const file = (n) => new URL(`../out/balance/${n}.json`, import.meta.url);
const { meta, results } = JSON.parse(readFileSync(file(name)));
const db = loadDb();
const decks = meta.decks;
const pct = (x) => (x == null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const isBase = (i) => !decks[i].joker;

// ---- aggregates ----
const decisive = results.filter((g) => g.w === 0 || g.w === 1);
const draws = results.length - decisive.length;
const baseGames = results.filter((g) => isBase(g.a) && isBase(g.b));
const baseDecisive = baseGames.filter((g) => g.w === 0 || g.w === 1);
const firstWr = baseDecisive.filter((g) => g.w === 0).length / baseDecisive.length;

// deck i vs deck j, both seats
const pair = {};
const bump = (i, j, win) => { const k = `${i}|${j}`; pair[k] ??= [0, 0]; pair[k][0] += win; pair[k][1] += 1; };
for (const g of decisive) { bump(g.a, g.b, g.w === 0 ? 1 : 0); bump(g.b, g.a, g.w === 1 ? 1 : 0); }
const pairWr = (i, j) => { const v = pair[`${i}|${j}`]; return v ? v[0] / v[1] : null; };

const baseIdx = decks.map((_, i) => i).filter(isBase);
const jokerIdx = decks.map((_, i) => i).filter((i) => !isBase(i));
const fieldWr = (i, opps) => {
  let w = 0, n = 0;
  for (const j of opps) { if (j === i) continue; const v = pair[`${i}|${j}`]; if (v) { w += v[0]; n += v[1]; } }
  return n ? w / n : null;
};
const deckRows = baseIdx.map((i) => ({ i, name: decks[i].name, wr: fieldWr(i, baseIdx) }));

// matchup matrix: every base deck needs 2 or more losing matchups
const losing = Object.fromEntries(baseIdx.map((i) => [i, baseIdx.filter((j) => j !== i && pairWr(i, j) !== null && pairWr(i, j) < 0.5).length]));

// cards: win rate of the player who played the card
const cardStat = {};
for (const g of decisive) for (const p of [0, 1]) for (const id of g.p[p]) { cardStat[id] ??= [0, 0]; cardStat[id][0] += g.w === p ? 1 : 0; cardStat[id][1] += 1; }
const cardRows = Object.entries(cardStat).map(([id, [w, n]]) => ({ id, name: db[id]?.name ?? id, type: db[id]?.type, element: db[id]?.element ?? 'Neutral', role: db[id]?.role ?? '', cost: db[id]?.cost, wr: w / n, n }))
  .sort((a, b) => b.wr - a.wr);

const groupWr = (key) => {
  const m = {};
  for (const c of cardRows.filter((c) => c.type === 'unit')) { m[c[key]] ??= [0, 0]; m[c[key]][0] += c.wr * c.n; m[c[key]][1] += c.n; }
  return Object.entries(m).map(([k, [w, n]]) => ({ k, wr: w / n, n })).sort((a, b) => b.wr - a.wr);
};

// joker effect: joker deck vs base field minus its base twin vs the same field
const jokerRows = jokerIdx.map((i) => {
  const twin = baseIdx.find((b) => decks[b].name === decks[i].name.replace('+J', ''));
  const wj = fieldWr(i, baseIdx.filter((b) => b !== twin));
  const wb = fieldWr(twin, baseIdx.filter((b) => b !== twin));
  return { name: decks[i].name, jokers: decks[i].jokers.join(', '), wj, wb, delta: wj - wb };
});

const rounds = results.map((g) => Math.ceil(g.t / 2)).sort((a, b) => a - b);
const median = rounds[Math.floor(rounds.length / 2)];
const byShrines = results.filter((g) => g.r === 'shrines').length / results.length;
const behind = decisive.filter((g) => g.s5 && g.s5[0] !== g.s5[1]);
const comeback = behind.filter((g) => (g.s5[0] < g.s5[1] ? 0 : 1) === g.w).length / behind.length;
const sum = (k) => results.reduce((a, g) => a + g[k][0] + g[k][1], 0);
const wasted = sum('mw') / sum('mg');
const skillShare = sum('sk') / (sum('sk') + sum('at'));

let sanity = null;
if (sanityName && existsSync(file(sanityName))) {
  const r = JSON.parse(readFileSync(file(sanityName))).results;
  const bots = JSON.parse(readFileSync(file(sanityName))).meta.bots;
  const gIdx = bots.indexOf('greedy');
  const dec = r.filter((g) => g.w === 0 || g.w === 1);
  sanity = { wr: dec.filter((g) => g.w === gIdx).length / dec.length, n: dec.length };
}

// ---- gates ----
// played win rate rises with cost (late cards are only played by players still standing),
// so each card is measured against the cards of its own cost
const tier = {};
for (const c of cardRows) { tier[c.cost] ??= [0, 0]; tier[c.cost][0] += c.wr * c.n; tier[c.cost][1] += c.n; }
for (const c of cardRows) c.rel = c.wr - tier[c.cost][0] / tier[c.cost][1];
const unitCards = cardRows.filter((c) => c.type === 'unit' || c.type === 'spell');
const cardsOut = unitCards.filter((c) => Math.abs(c.rel) > 0.05);
const decksOut = deckRows.filter((d) => d.wr < 0.45 || d.wr > 0.55);
const gates = [
  ['Every card is within 5 points of the cards of its own cost', cardsOut.length === 0, `${unitCards.length - cardsOut.length}/${unitCards.length} cards inside`],
  ['Every deck wins 45% to 55% against the field', decksOut.length === 0, `${deckRows.length - decksOut.length}/${deckRows.length} decks inside`],
  ['Every deck has 2 or more losing matchups', baseIdx.every((i) => losing[i] >= 2), `fewest: ${Math.min(...baseIdx.map((i) => losing[i]))} losing matchups`],
  ['The first player wins 48% to 52%', firstWr >= 0.48 && firstWr <= 0.52, pct(firstWr)],
  ['A Joker adds 3 points at most', jokerRows.every((j) => j.delta <= 0.03), `highest: ${(Math.max(...jokerRows.map((j) => j.delta)) * 100).toFixed(1)} points`],
  ['The median match lasts 8 to 11 rounds', median >= 8 && median <= 11, `${median} rounds`],
  ['90% of matches end with two Shrines broken', byShrines >= 0.9, pct(byShrines)],
  ['The player behind on round 5 wins 30% or more', comeback >= 0.3, pct(comeback)],
  ['Wasted Mana is 25% at most', wasted <= 0.25, pct(wasted)],
];

for (const [label, ok, detail] of gates) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
console.log(`\n${results.length} games, ${draws} draws, bots ${meta.bots.join(' vs ')}, Skill share ${pct(skillShare)}`);
if (sanity) console.log(`Greedy wins ${pct(sanity.wr)} against Random (${sanity.n} games)`);
console.log('\nDecks (against the field):');
for (const d of [...deckRows].sort((a, b) => b.wr - a.wr)) console.log(`  ${d.name.padEnd(14)} ${pct(d.wr)}  losing matchups ${losing[d.i]}`);
console.log('\nRoles:', groupWr('role').map((r) => `${r.k} ${pct(r.wr)}`).join(', '));
console.log('Elements:', groupWr('element').map((r) => `${r.k} ${pct(r.wr)}`).join(', '));
const byRel = [...cardRows].sort((a, b) => b.rel - a.rel);
console.log('\nTop 6 against their cost:', byRel.slice(0, 6).map((c) => `${c.name} ${(c.rel * 100).toFixed(1)}`).join(', '));
console.log('Bottom 6 against their cost:', byRel.slice(-6).map((c) => `${c.name} ${(c.rel * 100).toFixed(1)}`).join(', '));
console.log('\nJokers:', jokerRows.map((j) => `${j.name} ${(j.delta * 100).toFixed(1)}`).join(', '));

// ---- html ----
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const heat = (wr) => {
  if (wr == null) return 'transparent';
  const d = Math.max(-1, Math.min(1, (wr - 0.5) / 0.25));
  return d >= 0 ? `rgba(46, 160, 67, ${(d * 0.55).toFixed(2)})` : `rgba(218, 54, 51, ${(-d * 0.55).toFixed(2)})`;
};
const cell = (wr) => `<td style="background:${heat(wr)}">${wr == null ? '' : (wr * 100).toFixed(0)}</td>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latent Legends balance report</title>
<style>
:root{--bg:#fbfaf7;--ink:#1d1d1b;--mute:#6b6a64;--line:#e2dfd6;--ok:#2ea043;--bad:#da3633;--panel:#f1efe8}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--ink:#ecebe6;--mute:#9a988f;--line:#2e2d2a;--panel:#1d1c1a}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}
p.m{color:var(--mute);margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;white-space:nowrap}
.mx td,.mx th{text-align:center;padding:6px 4px;font-size:13px}
.wrap{overflow-x:auto}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
.cards{columns:2;column-gap:24px}@media (max-width:700px){.cards{columns:1}}
</style></head><body><main>
<h1>Latent Legends balance report</h1>
<p class="m">${results.length} bot games (${meta.bots.join(' vs ')}), ${meta.secs.toFixed(1)} s. Options: ${esc(JSON.stringify(meta.opts))}. Skill share ${pct(skillShare)}.${sanity ? ` Greedy wins ${pct(sanity.wr)} against Random.` : ''}</p>
<h2>Gates</h2>
<table>${gates.map(([l, ok, d]) => `<tr><td class="${ok ? 'ok' : 'bad'}">${ok ? 'Pass' : 'Fail'}</td><td>${esc(l)}</td><td>${esc(d)}</td></tr>`).join('')}</table>
<h2>Matchup matrix (win rate of the deck in the row)</h2>
<div class="wrap"><table class="mx"><tr><th></th>${baseIdx.map((j) => `<th>${esc(decks[j].name)}</th>`).join('')}<th>Field</th></tr>
${baseIdx.map((i) => `<tr><th>${esc(decks[i].name)}</th>${baseIdx.map((j) => (i === j ? '<td>·</td>' : cell(pairWr(i, j)))).join('')}${cell(fieldWr(i, baseIdx))}</tr>`).join('\n')}</table></div>
<h2>Roles and elements (matches where the character was played)</h2>
<table><tr><th>Role</th><th>Win rate</th></tr>${groupWr('role').map((r) => `<tr><td>${r.k}</td>${cell(r.wr)}</tr>`).join('')}</table>
<table style="margin-top:12px"><tr><th>Element</th><th>Win rate</th></tr>${groupWr('element').map((r) => `<tr><td>${r.k}</td>${cell(r.wr)}</tr>`).join('')}</table>
<h2>Jokers</h2>
<table><tr><th>Deck</th><th>Jokers</th><th>With Jokers</th><th>Without</th><th>Difference</th></tr>${jokerRows.map((j) => `<tr><td>${esc(j.name)}</td><td>${esc(j.jokers)}</td><td>${pct(j.wj)}</td><td>${pct(j.wb)}</td><td class="${j.delta <= 0.03 ? 'ok' : 'bad'}">${(j.delta * 100).toFixed(1)}</td></tr>`).join('')}</table>
<h2>Cards (win rate of the player who played the card)</h2>
<div class="wrap"><table><tr><th>Card</th><th>Type</th><th>Element</th><th>Role</th><th>Cost</th><th>Win rate</th><th>Against its cost</th><th>Games</th></tr>
${[...cardRows].sort((a, b) => b.rel - a.rel).map((c) => `<tr><td>${esc(c.name)}</td><td>${c.type}</td><td>${c.element}</td><td>${c.role}</td><td>${c.cost}</td>${cell(c.wr)}<td style="background:${heat(0.5 + c.rel * 2.5)}">${(c.rel * 100).toFixed(1)}</td><td>${c.n}</td></tr>`).join('\n')}</table></div>
</main></body></html>`;
writeFileSync(new URL(`../out/balance/${name}.html`, import.meta.url), html);
console.log(`\nwrote out/balance/${name}.html`);
