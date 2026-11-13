// Latent Legends, the card book: every card with its frame, its animation, what it is for and where it sits
// on the element and role wheels. Opened from CARDS on the title, and from the NEW CARDS note a returning player sees once.
// Sentences are set in the body font on image plates; frames, icons, badges and labels are image art.
import { POOL, NEW_CARDS } from '../engine/deck.js';

const $ = (id) => document.getElementById(id);
import { uiArt } from './uiart.js';
const label = (key, alt) => `<img class="lbl" src="${uiArt(`lbl_${key}`)}" alt="${alt}" data-fail="span">`;

// both wheels: each beats the next one and the one three after
const ELEMENTS = ['Fire', 'Wild', 'Storm', 'Frost', 'Shadow'];
const ROLES = ['Tank', 'Fighter', 'Mage', 'Archer', 'Support'];
const beats = (wheel, x) => { const i = wheel.indexOf(x); return i < 0 ? [] : [wheel[(i + 1) % 5], wheel[(i + 3) % 5]]; };
const beatenBy = (wheel, x) => wheel.filter((y) => beats(wheel, y).includes(x));
const NEW = new Set(NEW_CARDS);

const STYLE = {
  Fire: 'Fire attacks early and burns.',
  Wild: 'Wild grows and heals.',
  Storm: 'Storm is fast. Its lightning jumps lanes.',
  Frost: 'Frost freezes and holds the line.',
  Shadow: 'Shadow wears enemies down and drains life.',
};
const ROLE = {
  Tank: 'Front row. Armor shrugs off physical hits, and Taunt pulls enemy Skills onto it.',
  Fighter: 'Front row. Dive jumps over the Front and strikes the enemy Back unit.',
  Mage: 'Back row. Saves up Mana, then Blast spends it all as magic on every enemy in the lane.',
  Archer: 'Back row. Snipe hits any enemy in the lane, Back row too.',
  Support: 'Back row. Siphon hurts an enemy and heals your Front unit by the same amount.',
};
// one line about each card: who the character is, or when a spell or joker pays off
const ABOUT = {
  ember_warden: 'A forge guard whose shield never cools.',
  cinder_raider: 'Runs through the smoke to hit what hides behind it.',
  pyre_sage: 'Feeds the fire slowly, then lets it all go at once.',
  flare_archer: 'Arrows that leave a trail of sparks.',
  hearth_keeper: 'Small, warm and stubborn. Costs just 1.',
  barkhide: 'Old bark over older roots. Very hard to move.',
  thorn_stalker: 'A hunter grown from briar and patience. Hits hardest of all Fighters.',
  grove_shaman: 'A young voice of the grove. Cheap, and it grows into its Blast.',
  briar_slinger: 'Throws thorns from the back of the thicket.',
  bloom_tender: 'Where it walks, wounds close.',
  thunder_bulwark: 'A 1 Essence shield that crackles when struck.',
  gale_duelist: 'Fast feet, faster blade.',
  tempest_caller: 'Gathers the storm, then breaks it over a whole lane.',
  spark_archer: 'Every arrow is a lightning strike.',
  squall_mender: 'The strongest Siphon in the game: rain that hurts foes and heals friends.',
  glacier_shield: 'A wall of old ice.',
  frost_reaver: 'Cuts through the line to reach the ones behind it.',
  rime_witch: 'Cold that builds and builds, then lands all at once.',
  icicle_sniper: 'Patient. One cold shot at a time.',
  snow_lantern: 'A soft light that keeps the Front alive.',
  gloom_sentinel: 'The heaviest Armor in the game. Stands in the dark and does not fall.',
  night_blade: 'Costs 1, strikes quick, gone before you notice.',
  void_weaver: 'Spins the void into a slow, wide Blast.',
  umbral_hunter: 'Shoots from the shadows, at any row.',
  dusk_oracle: 'Drinks the light from enemies to heal friends.',
  fireball: 'Finish a hurt unit, or hit a Back unit your Attacks cannot reach.',
  lava_pool: 'Best on a crowded lane: every enemy there burns twice.',
  thorns: 'Put it on your Front unit. Every Attack against it hurts the attacker.',
  regrowth: 'Heals a little and grows the unit for good.',
  chain_lightning: 'Aim at a unit with 2 HP or less: the bolt then jumps to the next lane.',
  gust: 'Push an enemy Front away and your Attacks in that lane reach the Shrine.',
  frost_nova: 'Freeze a lane before its Fighter or Mage can spend a full Mana bar.',
  crystal_wall: 'A cheap wall for an empty Front. It buys your Back units time.',
  void_bolt: 'Hit an enemy and heal your own unit in that lane.',
  gravity_well: 'Drags the enemy Back unit to the Front, where your Attacks can hit it.',
  spark: 'One more Essence this turn: play a big card early.',
  mirror: 'Turn your unit into the element that beats the enemy in its lane.',
  swap: 'Free. Moves two of your units between lanes, so your Tank stands where the danger is.',
  mimic: 'Copies the last character played, yours or the enemy\'s, one point smaller.',
  rebirth: 'Brings your most expensive fallen character back to your hand.',
};

const TYPES = { all: () => true, units: (c) => c.type === 'unit', spells: (c) => c.type === 'spell', jokers: (c) => c.type === 'joker' };

// clipOf(id, action) and vfxOf(id) give { url, m } (sprites.json and vfx.json entries) or null; sound(name) plays a clip's sound
export function createBook({ db, cardEl, numImg, clipOf, vfxOf, sound, show, hide }) {
  const byCost = (a, b) => (db[a].cost ?? 0) - (db[b].cost ?? 0) || db[a].name.localeCompare(db[b].name);
  const ids = [...POOL].sort(byCost);
  let el = 'all', type = 'all', onlyNew = false, pick = null, back = null, built = false;

  // ---------- the grid ----------
  function build() {
    if (built) return;
    built = true;
    $('bookEls').innerHTML = `<button data-el="all">${label('all', 'ALL')}</button>`
      + ELEMENTS.map((e) => `<button data-el="${e}" title="${e}"><img src="${uiArt(`el_${e.toLowerCase()}`)}" alt="${e}"></button>`).join('');
    $('bookTypes').innerHTML = Object.keys(TYPES).filter((k) => k !== 'all').map((k) => `<button data-type="${k}">${label(k, k.toUpperCase())}</button>`).join('')
      + `<button data-new="1" class="new"><img src="${uiArt(`badge_new`)}" alt="NEW" data-fail="text"></button>`;
    const grid = $('bookGrid');
    for (const id of ids) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.dataset.id = id;
      const sc = document.createElement('div');
      sc.className = 'scaler';
      sc.appendChild(cardEl(id));
      s.appendChild(sc);
      if (NEW.has(id)) s.insertAdjacentHTML('beforeend', `<img class="new-badge" src="${uiArt(`badge_new`)}" alt="NEW" data-fail="remove">`);
      s.onclick = () => select(id);
      grid.appendChild(s);
    }
    $('bookEls').onclick = (e) => { const b = e.target.closest('button'); if (b) { el = b.dataset.el; render(); } };
    $('bookTypes').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.new) onlyNew = !onlyNew; else type = type === b.dataset.type ? 'all' : b.dataset.type;
      render();
    };
    $('bookBack').onclick = close;
    $('bookStage').onclick = () => pick && play(pick, true);
  }

  const visible = (id) => {
    const c = db[id];
    return TYPES[type](c) && (el === 'all' || c.element === el) && (!onlyNew || NEW.has(id));
  };
  function render() {
    document.querySelectorAll('#bookEls button').forEach((b) => b.classList.toggle('on', b.dataset.el === el));
    document.querySelectorAll('#bookTypes button').forEach((b) => b.classList.toggle('on', b.dataset.new ? onlyNew : b.dataset.type === type));
    let first = null;
    for (const s of $('bookGrid').children) {
      const show = visible(s.dataset.id);
      s.classList.toggle('hidden', !show);
      if (show) first ??= s.dataset.id;
    }
    if (!pick || !visible(pick)) select(first);
    else $('bookGrid').querySelectorAll('.slot').forEach((s) => s.classList.toggle('on', s.dataset.id === pick));
  }

  // ---------- the page of one card ----------
  function select(id) {
    pick = id;
    $('bookGrid').querySelectorAll('.slot').forEach((s) => s.classList.toggle('on', s.dataset.id === id));
    const page = $('bookPage');
    if (!id) { page.classList.add('empty'); stop(); return; }
    page.classList.remove('empty');
    const c = db[id], unit = c.type === 'unit';
    $('bookCard').replaceChildren(cardEl(id));
    const kind = unit ? `${c.element} ${c.role}` : c.type === 'spell' ? `${c.element} spell` : 'Joker';
    $('bookKind').innerHTML = `${unit ? `<img src="${uiArt(`role_${c.role.toLowerCase()}`)}" alt="">` : ''}<span>${kind}</span>${NEW.has(id) ? `<img class="nb" src="${uiArt(`badge_new`)}" alt="NEW" data-fail="remove">` : ''}`;
    $('bookAbout').textContent = ABOUT[id] ?? '';
    $('bookRole').textContent = unit ? ROLE[c.role] : '';
    $('bookRole').classList.toggle('hidden', !unit);
    $('bookStats').innerHTML = unit ? [
      ['badge_atk', c.atk, 'Attack'], ['badge_hp', c.hp, 'Health'], c.armor ? ['badge_armor', c.armor, 'Armor'] : null, c.ward ? ['badge_ward', c.ward, 'Ward'] : null,
    ].filter(Boolean).map(([img, v, t]) => `<span title="${t}"><img src="${uiArt(`${img}`)}" alt="">${numImg(v)}</span>`).join('')
      + `<span class="mana" title="Mana at the start / the most it holds">Mana ${c.startMana}/${c.maxMana}</span>` : '';
    wheel(c);
    play(id, false);
  }

  // the element wheel: arrows from this card's element to the two it beats (green), and in from the two that beat it (red)
  function wheel(c) {
    const R = 112, C = 150, at = (i) => [C + R * Math.sin((i * 2 * Math.PI) / 5), C - R * Math.cos((i * 2 * Math.PI) / 5)];
    const me = c.element && ELEMENTS.includes(c.element) ? c.element : null;
    const arrow = (a, b, cls) => {
      const [x1, y1] = at(ELEMENTS.indexOf(a)), [x2, y2] = at(ELEMENTS.indexOf(b));
      const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy), k = 36 / d;
      return `<line class="${cls}" x1="${x1 + dx * k}" y1="${y1 + dy * k}" x2="${x2 - dx * k}" y2="${y2 - dy * k}" marker-end="url(#ah-${cls})"/>`;
    };
    const lines = me ? [...beats(ELEMENTS, me).map((b) => arrow(me, b, 'win')), ...beatenBy(ELEMENTS, me).map((b) => arrow(b, me, 'lose'))].join('') : '';
    const icons = ELEMENTS.map((e, i) => {
      const [x, y] = at(i);
      const cls = !me ? 'dim' : e === me ? 'me' : beats(ELEMENTS, me).includes(e) ? 'win' : 'lose';
      // a tick or a cross on the elements it beats or loses to: the arrows' green and red alone fail colour blind eyes
      const badge = cls === 'win' || cls === 'lose' ? `<image class="bdg" href="${uiArt(`badge_${cls}`)}" x="${x + 10}" y="${y - 36}" width="28" height="28"/>` : '';
      return `${cls === 'me' ? `<circle class="halo" cx="${x}" cy="${y}" r="38"/>` : ''}<image class="${cls}" href="${uiArt(`el_${e.toLowerCase()}`)}" x="${x - 30}" y="${y - 30}" width="60" height="60"/>${badge}`;
    }).join('');
    $('bookWheel').innerHTML = `<svg viewBox="0 0 300 300" aria-hidden="true"><defs>
      <marker id="ah-win" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z"/></marker>
      <marker id="ah-lose" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>
      ${lines}${icons}</svg>`;
    const list = (xs) => xs.map((e) => `<img src="${uiArt(`el_${e.toLowerCase()}`)}" alt="" title="${e}"><b>${e}</b>`).join('');
    const roleLine = c.type === 'unit' ? `<p class="rl">As a ${c.role}, it beats ${beats(ROLES, c.role).join(' and ')} and loses to ${beatenBy(ROLES, c.role).join(' and ')}.</p>` : '';
    $('bookVs').innerHTML = me ? `<p class="st">${STYLE[me]}</p>
      <div class="row win"><span><img class="bdg" src="${uiArt(`badge_win`)}" alt="">Strong against</span>${list(beats(ELEMENTS, me))}</div>
      <div class="row lose"><span><img class="bdg" src="${uiArt(`badge_lose`)}" alt="">Weak against</span>${list(beatenBy(ELEMENTS, me))}</div>
      <p class="rule">Strong: it deals 1 more damage there and takes 1 less.</p>${roleLine}`
      : '<p class="st">Jokers have no element: they fit any deck. A deck holds at most 2.</p>';
  }

  // ---------- the animation on the pedestal: the character's idle loop (a Skill when you tap), or the spell's effect ----------
  const cv = () => $('bookAnim');
  let raf = 0, seq = null;
  const cache = new Map();
  const load = (url) => cache.get(url) ?? cache.set(url, new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = url; })).get(url);
  function stop() { cancelAnimationFrame(raf); raf = 0; seq = null; const g = cv().getContext('2d'); g.clearRect(0, 0, cv().width, cv().height); }
  // only the open card's sheets stay decoded: a full sheet is about 16 MB, and browsing the book must not
  // pile up what sheetsForMatch keeps out of a match
  function release(keep = new Set()) {
    for (const [url, p] of cache) if (!keep.has(url)) { p.then((im) => { if (im) im.src = ''; }); cache.delete(url); }
  }

  async function play(id, tapped) {
    const c = db[id], unit = c.type === 'unit';
    // units: idle, or on a tap the Skill and an Attack before the idle again; spells and jokers: their effect, looped with a rest
    const steps = unit ? (tapped ? ['skill', 'attack', 'idle'] : ['idle']).map((a) => clipOf(id, a)).filter(Boolean) : [vfxOf(id)].filter(Boolean);
    const token = {};
    seq = token;
    $('bookStage').classList.toggle('none', !steps.length);
    $('bookStage').dataset.kind = unit ? 'unit' : 'fx';
    $('bookPage').style.setProperty('--el', `var(--el-${(c.element || 'joker').toLowerCase()})`);
    release(new Set(steps.map((s) => s.url)));
    if (!steps.length) { stop(); return; }
    const imgs = await Promise.all(steps.map((s) => load(s.url)));
    if (seq !== token) return;
    cancelAnimationFrame(raf);
    let i = 0, t0 = performance.now();
    if (unit && tapped) sound?.(steps[0].sound);
    const g = cv().getContext('2d');
    const frame = (now) => {
      if (seq !== token) return;
      const s = steps[i], im = imgs[i], m = s.m;
      const end = m.end ?? m.frames;
      let k = Math.floor(((now - t0) / 1000) * m.fps);
      if (k >= end) {
        if (i < steps.length - 1) { i++; t0 = now; k = 0; if (steps[i].sound && steps[i] !== steps.at(-1)) sound?.(steps[i].sound); }
        else if (!unit && k < end + m.fps) k = -1;                  // a short rest between two plays of an effect
        else { t0 = now; k = 0; }
      }
      g.clearRect(0, 0, cv().width, cv().height);
      if (im && k >= 0) {
        const cell = m.cell * (im.width / (m.cols * m.cell));      // the half-size sheets have half-size cells
        const sx = (k % m.cols) * cell, sy = Math.floor(k / m.cols) * cell;
        g.globalCompositeOperation = m.blend ?? 'source-over';
        // a unit stands on the pedestal by its pivot; an effect sits in the middle
        const size = unit ? 540 : 420, [px, py] = unit ? (m.pivot ?? [m.cell / 2, m.cell * 0.86]) : [m.cell / 2, m.cell / 2];
        const k2 = size / m.cell, x = cv().width / 2 - px * k2, y = (unit ? cv().height - 80 : cv().height * 0.58) - py * k2;
        g.drawImage(im, sx, sy, cell, cell, x, y, size, size);
        g.globalCompositeOperation = 'source-over';
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  // ---------- open and close ----------
  function open({ from, onlyNewCards = false } = {}) {
    build();
    back = from ?? null;
    onlyNew = onlyNewCards;
    if (onlyNewCards) { el = 'all'; type = 'all'; }
    if (from) hide(from);
    show('book');
    render();
  }
  function close() { stop(); release(); hide('book'); if (back) show(back); }
  return { open, close };
}
