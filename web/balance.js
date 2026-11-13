// The public balance page: reads the bot tournaments sim/balance_page.mjs writes to data/balance_<bot>.json.
// Fixed words are lettering art (lbl_*, name_*); numbers, notes and captions are set in the display font.
import { STARTERS } from '../engine/deck.js';

const $ = (id) => document.getElementById(id);
import { uiArt } from './uiart.js';
const UI_ART = 'assets/ui/';
const ELEMENTS = ['Fire', 'Frost', 'Wild', 'Storm', 'Shadow'];
const DECK_LABEL = { balanced: 'balanced', ember_rush: 'ember_rush', frost_bastion: 'frost_bastion', storm_surge: 'storm_surge', shadow_veil: 'shadow_veil', wild_grove: 'wild_grove' };
const BOT_NOTE = {
  greedy: 'Normal bot: the best move it can see. 500 games for every deck pairing.',
  hard: 'Hard bot: plans two turns ahead. 200 games for every deck pairing.',
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const lbl = (key, alt) => `<img class="lbl" src="${uiArt(`lbl_${key}`)}" alt="${alt}">`;
const deckName = (key, name) => `<img class="dlbl" src="${uiArt(`lbl_${DECK_LABEL[key]}`)}" alt="${name}">`;
const elIcon = (e) => `<img class="el" src="${uiArt(`el_${e.toLowerCase()}`)}" alt="${e}" title="${e}">`;

const [db, data] = await Promise.all([
  fetch('../data/cards.json').then((r) => r.json()).then((d) => Object.fromEntries(d.cards.map((c) => [c.id, c]))),
  Promise.all(['greedy', 'hard'].map((b) => fetch(`data/balance_${b}.json`).then((r) => r.json()))).then(([greedy, hard]) => ({ greedy, hard })),
]);

// a deck at a glance: its three dearest units fanned out, and its two main elements
function deckInfo(key) {
  const ids = STARTERS[key].cards;
  const units = [...new Set(ids)].filter((id) => db[id]?.type === 'unit').sort((a, b) => db[b].cost - db[a].cost).slice(0, 3);
  const count = {};
  for (const id of ids) if (ELEMENTS.includes(db[id]?.element)) count[db[id].element] = (count[db[id].element] ?? 0) + 1;
  const els = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => e);
  return { units, els };
}
const DECKS = Object.fromEntries(Object.keys(STARTERS).map((k) => [k, deckInfo(k)]));
const fan = (key) => `<span class="fan">${DECKS[key].units.map((id, i) => `<img style="--i:${i}" src="assets/portraits/${id}.webp" alt="">`).join('')}</span>`;

let bot = 'greedy', sortBy = 'win';
try { bot = localStorage.getItem('latent.balance.bot') === 'hard' ? 'hard' : 'greedy'; } catch {}

function render() {
  const d = data[bot];
  document.querySelectorAll('.bots button').forEach((b) => b.classList.toggle('on', b.dataset.bot === bot));
  document.querySelectorAll('.sort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === sortBy));
  $('botNote').textContent = BOT_NOTE[bot];

  $('stats').innerHTML = [
    ['games_played', 'Games played', d.games.toLocaleString('en-US')],
    ['first_player_wins', 'First player wins', pct(d.firstPlayerWin)],
    ['rounds_per_game', 'Rounds per game', d.rounds.toFixed(1)],
    ['draws', 'Draws', pct(d.draws)],
  ].map(([k, alt, v]) => `<div class="stat"><b>${v}</b>${lbl(k, alt)}</div>`).join('');

  const decks = [...d.decks].sort((a, b) => b.win - a.win);
  $('decks').innerHTML = decks.map((x) => {
    const lead = DECKS[x.key].els[0];
    return `<div class="deck">
      ${fan(x.key)}
      <span class="who">${deckName(x.key, x.name)}<span class="els">${DECKS[x.key].els.map(elIcon).join('')}</span></span>
      <span class="bar" style="--w:${(x.win * 100).toFixed(1)}%; --c:var(--el-${lead.toLowerCase()})"><i></i><s></s></span>
      <b class="val">${pct(x.win)}</b></div>`;
  }).join('');

  // deck against deck, in the order of the table above; cells lean blue below 50% and orange above
  const keys = decks.map((x) => x.key);
  const head = `<tr><th></th>${keys.map((k) => `<th class="col" title="${STARTERS[k].name}">${fan(k)}<span class="els">${DECKS[k].els.map(elIcon).join('')}</span><img class="clbl" src="${uiArt(`lbl_${DECK_LABEL[k]}`)}" alt="${STARTERS[k].name}"></th>`).join('')}</tr>`;
  const rows = keys.map((a) => `<tr><th class="row">${deckName(a, STARTERS[a].name)}</th>${keys.map((b) => {
    if (a === b) return '<td class="mirror"></td>';
    const v = d.vs[a][b], t = Math.min(1, Math.abs(v - 0.5) / 0.3);
    return `<td style="--t:${t.toFixed(2)}" class="${v >= 0.5 ? 'hi' : 'lo'}" title="${STARTERS[a].name} against ${STARTERS[b].name}">${pct(v)}</td>`;
  }).join('')}</tr>`).join('');
  $('vs').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;

  const cards = d.cards.filter((c) => db[c.id] && db[c.id].type !== 'token').sort((a, b) => (sortBy === 'win' ? b.win - a.win : b.played - a.played));
  const most = Math.max(...cards.map((c) => c.played));
  $('cards').innerHTML = cards.map((c, i) => {
    const card = db[c.id], el = ELEMENTS.includes(card.element) ? elIcon(card.element) : '';
    return `<li><span class="rank">${i + 1}</span><img class="pt" src="assets/portraits/${c.id}.webp" alt="">
      <span class="nm"><img class="nmimg" src="${uiArt(`name_${c.id}`)}" alt="${card.name}">${el}</span>
      <span class="mini" title="Played in ${c.played.toLocaleString('en-US')} games"><i style="width:${((c.played / most) * 100).toFixed(1)}%"></i></span>
      <b class="val ${c.win >= 0.5 ? 'hi' : 'lo'}">${pct(c.win)}</b></li>`;
  }).join('');
}

document.querySelectorAll('.bots button').forEach((b) => { b.onclick = () => { bot = b.dataset.bot; try { localStorage.setItem('latent.balance.bot', bot); } catch {} render(); }; });
document.querySelectorAll('.sort button').forEach((b) => { b.onclick = () => { sortBy = b.dataset.sort; render(); }; });
render();
