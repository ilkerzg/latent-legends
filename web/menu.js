// Latent Legends, the screens before a match: the title, the setup (who you play, which deck) and the deck builder.
// The deck rules live in engine/deck.js, shared with the bots and the room server. Fixed words are lettering images
// (lbl_*.webp, name_*.webp); only deck names, blurbs, notes and rule errors are set in the display font.
import { POOL, NEW_CARDS, STARTERS, DECK_RULES, deckStats, validateDeck } from '../engine/deck.js';
import { createBook } from './book.js';

const $ = (id) => document.getElementById(id);
import { uiArt } from './uiart.js';
const label = (key, alt) => `<img class="lbl" src="${uiArt(`lbl_${key}`)}" alt="${alt}">`;
const LEVELS = {
  easy: 'Forgets its spells and plays loose.',
  normal: 'Takes the best move it can see.',
  hard: 'Plans two turns ahead.',
};
// deck names are lettering images too; a name without its image falls back to the display font
// jokers count under no element; the five with their own icon
const ELEMENTS = ['Fire', 'Wild', 'Storm', 'Frost', 'Shadow'];
const DECK_LABEL = { custom: 'my_deck', balanced: 'balanced', ember_rush: 'ember_rush', frost_bastion: 'frost_bastion', storm_surge: 'storm_surge', shadow_veil: 'shadow_veil', wild_grove: 'wild_grove' };
const deckName = (key, name) => (DECK_LABEL[key]
  ? `<img class="dlbl" src="${uiArt(`lbl_${DECK_LABEL[key]}`)}" alt="${name}" data-fail="span">`
  : name);
const FILTERS = { all: () => true, units: (c) => c.type === 'unit', spells: (c) => c.type === 'spell', jokers: (c) => c.type === 'joker' };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// online: { create(deck), join(code, deck), cancel() } from play.js, or null while there is no room server
export function createMenu({ db, cardEl, numImg, onPlay, onPrepare, onAudio, online = null, clipOf, vfxOf, sound }) {
  // deck2 and seat: the second player's deck and whose deck the tiles set, for two players on one screen
  // saved settings are only trusted as far as they name things that exist: they end up in the page
  const saved = store.get('latent.setup', {}) ?? {};
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  const prefs = {
    mode: pick(saved.mode, ['bot', 'hotseat', 'online'], 'bot'), level: pick(saved.level, Object.keys(LEVELS), 'normal'),
    deck: pick(saved.deck, Object.keys(DECK_LABEL), 'balanced'), deck2: pick(saved.deck2, Object.keys(DECK_LABEL), 'frost_bastion'),
    seat: pick(saved.seat, [0, 1], 0),
  };
  // without a room server there is no MULTIPLAYER tab
  if (!online && prefs.mode === 'online') prefs.mode = 'bot';
  document.querySelector('#setup .tab[data-mode=online]').classList.toggle('hidden', !online);
  let custom = store.get('latent.deck', null);
  custom = Array.isArray(custom) ? custom.filter((id) => typeof id === 'string' && Object.hasOwn(db, id)).slice(0, 60) : null;
  if (prefs.deck === 'custom' && !custom) prefs.deck = 'balanced';
  if (prefs.deck2 === 'custom' && !custom) prefs.deck2 = 'frost_bastion';
  // the deck the tiles show and set: the picking player's in a two player match, else yours
  const deckKey = () => (prefs.mode === 'hotseat' && prefs.seat ? 'deck2' : 'deck');
  let work = [], filter = 'all', elFilter = null, room = null;

  const savePrefs = () => store.set('latent.setup', prefs);
  const deckCards = (key) => (key === 'custom' ? custom ?? [] : STARTERS[key]?.cards ?? STARTERS.balanced.cards);
  const legal = (ids) => validateDeck(db, ids).ok;
  const byCost = (a, b) => (db[a].cost ?? 0) - (db[b].cost ?? 0) || db[a].name.localeCompare(db[b].name);

  // ---------- screens: one shared backdrop with a camera over its key art; screens come and go in parts ----------
  // where the camera looks for each screen: pan x, pan y (stage px) and zoom; deeper screens sit further along
  const CAMERA = { start: [0, 0, 1], setup: [-46, -8, 1.06], builder: [-92, -14, 1.1], book: [46, -8, 1.06] };
  // the screens whose parts land one after another (the title keeps its own logo drop)
  const CAST = new Set(['setup', 'builder', 'book']);
  // each visible part of a screen gets the side it sits nearest (--dx, --dy) and its turn from the top (--i)
  function cast(el) {
    const st = $('stage').getBoundingClientRect(), k = st.width / 1920;
    const parts = [...el.children].filter((c) => !c.classList.contains('hidden') && getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'fixed')
      .map((c) => { const r = c.getBoundingClientRect(); return { c, x: (r.left + r.width / 2 - st.left) / k - 960, y: (r.top + r.height / 2 - st.top) / k - 540 }; })
      .sort((a, b) => a.y - b.y || a.x - b.x);
    parts.forEach(({ c, x, y }, i) => {
      const side = Math.abs(x) / 960 > Math.abs(y) / 540;
      c.classList.add('part');
      c.style.setProperty('--i', i);
      c.style.setProperty('--dx', side ? `${Math.sign(x) * 160}px` : '0px');
      c.style.setProperty('--dy', side ? '0px' : `${Math.sign(y || -1) * 120}px`);
    });
  }
  function camera(id) {
    const c = CAMERA[id], art = $('menuBg').querySelector('.keyart');
    if (!c || !art) return;
    art.style.translate = `${c[0]}px ${c[1]}px`;
    art.style.scale = c[2];
  }
  function show(id) {
    const el = $(id);
    el.classList.remove('hidden', 'leave', 'enter', 'cast-out', 'landed');   // landed: the title's logo skips its drop only after the loading screen
    if (CAST.has(id)) { el.classList.add('cast'); cast(el); }
    camera(id);
    void el.offsetWidth;
    el.classList.add('enter');
  }
  function hide(id) {
    const el = $(id);
    if (el.classList.contains('hidden') || el.classList.contains('leave')) return;
    el.classList.remove('enter');
    if (el.classList.contains('screen')) { cast(el); el.classList.add('cast-out'); }
    el.classList.add('leave');
    // children animate too, so only this element's own animation counts; a hidden tab may never send it, hence the timer
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('animationend', onEnd);
      if (el.classList.contains('leave')) { el.classList.add('hidden'); el.classList.remove('leave'); }
    };
    const onEnd = (e) => { if (e.target === el) done(); };
    const timer = setTimeout(done, 700);
    el.addEventListener('animationend', onEnd);
  }

  // ---------- setup ----------
  function renderSetup() {
    document.querySelectorAll('#setup .tab').forEach((b) => b.classList.toggle('on', b.dataset.mode === prefs.mode));
    $('paneBot').classList.toggle('hidden', prefs.mode !== 'bot');
    $('paneOnline').classList.toggle('hidden', prefs.mode !== 'online');
    $('paneHot').classList.toggle('hidden', prefs.mode !== 'hotseat');
    renderHot();
    document.querySelectorAll('#levels button').forEach((b) => b.classList.toggle('on', b.dataset.level === prefs.level));
    $('levelNote').textContent = LEVELS[prefs.level];
    const stars = { easy: 1, normal: 2, hard: 3 }[prefs.level];
    $('levelStars').innerHTML = [1, 2, 3].map((i) => `<i class="${i <= stars ? 'on' : ''}"></i>`).join('');
    renderTiles();
    renderRoom();
    const ok = legal(deckCards(prefs.deck));
    $('setupStart').classList.toggle('hidden', prefs.mode === 'online');
    $('setupStart').disabled = !ok || (prefs.mode === 'hotseat' && !legal(deckCards(prefs.deck2)));
    $('createRoom').disabled = $('joinRoom').disabled = !ok || !online || !!room;
    prepare();
  }
  // the decks on the setup start loading in the background (play.js prepareDecks)
  function prepare() { onPrepare?.({ mode: prefs.mode, deck: deckCards(prefs.deck), deck2: deckCards(prefs.deck2) }); }

  function sigCards(ids) {
    // the three dearest units show on the tile, so each deck reads at a glance
    return [...new Set(ids)].filter((id) => db[id]?.type === 'unit').sort((a, b) => byCost(b, a)).slice(0, 3);
  }
  function tile(key, name, blurb, ids) {
    const st = deckStats(db, ids), ok = legal(ids);
    // the deck's elements by count, at most three shown
    const els = Object.entries(st.elements).filter(([e, n]) => n > 0 && ELEMENTS.includes(e)).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([e, n]) => `<img src="${uiArt(`el_${e.toLowerCase()}`)}" alt="${e}">${numImg(n)}`).join('');
    const art = sigCards(ids).map((id, i) => `<img style="--i:${i}" src="assets/portraits/${id}.webp" alt="">`).join('');
    return `<button class="deck-tile${prefs[deckKey()] === key ? ' on' : ''}${ok ? '' : ' bad'}" data-deck="${key}">
      <span class="fan">${art || '<i class="plus">+</i>'}</span>
      <span class="txt"><b class="dname">${deckName(key, name)}</b><span class="blurb">${blurb}</span>
      <span class="els">${els}</span></span></button>`;
  }
  function renderTiles() {
    const mine = custom
      ? tile('custom', 'My Deck', legal(custom) ? 'Your own build.' : 'Not legal yet. Open the builder.', custom)
      : `<button class="deck-tile new" data-deck="new"><span class="fan"><i class="plus">+</i></span><span class="txt"><b class="dname">${deckName('custom', 'My Deck')}</b><span class="blurb">Build your own from the card pool.</span></span></button>`;
    const html = mine + Object.entries(STARTERS).map(([k, d]) => tile(k, d.name, d.blurb, d.cards)).join('');
    if ($('deckTiles').dataset.html !== html) { $('deckTiles').innerHTML = html; $('deckTiles').dataset.html = html; }
  }

  // two players: the picking player's medal glows, each medal names its deck
  function renderHot() {
    document.querySelectorAll('#paneHot .seat').forEach((b) => b.classList.toggle('on', +b.dataset.seat === prefs.seat));
    for (const s of [0, 1]) {
      const key = prefs[s ? 'deck2' : 'deck'], html = deckName(key, key === 'custom' ? 'My Deck' : STARTERS[key]?.name ?? key);
      if ($(`hotDeck${s}`).dataset.html !== html) { $(`hotDeck${s}`).innerHTML = html; $(`hotDeck${s}`).dataset.html = html; }
    }
    $('hotNote').textContent = `Player ${prefs.seat + 1}, pick your deck on the right. Pass the screen between turns.`;
  }

  // the versus panel: your medal, then VS (or the room code once there is a room), then the opponent's medal
  function renderRoom() {
    $('roomBox').classList.toggle('hidden', !room);
    $('roomForm').classList.toggle('hidden', !!room);
    $('meName').textContent = online?.name ?? 'You';
    const code = room?.code ?? null, foe = room?.opponent ?? null;
    // the code comes from the room server, so it goes in as text
    const mid = code ? `<img class="room-lbl" src="${uiArt(`lbl_room`)}" alt="ROOM"><b class="code"></b>` : room ? `<b class="code">...</b>` : `<img class="vs" src="${uiArt(`lbl_vs`)}" alt="VS">`;
    if ($('vsMid').dataset.html !== mid + (code ?? '')) {
      $('vsMid').innerHTML = mid;
      if (code) $('vsMid').querySelector('.code').textContent = code;
      $('vsMid').dataset.html = mid + (code ?? '');
    }
    $('foeFace').classList.toggle('hidden', !foe);
    $('foeQ').classList.toggle('hidden', !!foe);
    $('foeMedal').classList.toggle('joined', !!foe);
    const who = foe ? foe : room ? `${label('waiting', 'Waiting')}` : `${label('opponent', 'Opponent')}`;
    $('foeName').classList.toggle('on', !!foe);
    if ($('foeName').dataset.html !== who) { if (foe) $('foeName').textContent = foe; else $('foeName').innerHTML = who; $('foeName').dataset.html = who; }
    if (!room && !$('netNote').dataset.err) note(online ? 'Create a room and send the link, or type a friend\'s code.' : '');
    else if (room && !foe) note(room.host ? 'Send the link or the code to a friend. The match starts when they join.' : `Joining room ${room.code}.`);
    else if (foe) note(`${foe} joined. Starting.`);
    renderCode();
  }
  function renderCode() {
    const v = $('roomCode').value, spans = $('codeBoxes').querySelectorAll('span');
    spans.forEach((sp, i) => { sp.textContent = v[i] ?? ''; sp.classList.toggle('caret', i === Math.min(v.length, 4)); });
  }

  $('setup').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.mode) { prefs.mode = t.dataset.mode; savePrefs(); renderSetup(); return; }
    if (t.dataset.level) { prefs.level = t.dataset.level; savePrefs(); renderSetup(); return; }
    if (t.dataset.seat) { prefs.seat = +t.dataset.seat; savePrefs(); renderSetup(); return; }
    if (t.dataset.deck === 'new') { openBuilder(); return; }
    if (t.dataset.deck) {
      if (t.dataset.deck === 'custom' && !legal(custom)) { openBuilder(); return; }
      prefs[deckKey()] = t.dataset.deck; savePrefs(); renderSetup(); return;
    }
  });
  $('openBuilder').onclick = () => openBuilder();
  $('setupBack').onclick = () => { if (room) leaveRoom(); hide('setup'); show('start'); };
  $('setupStart').onclick = () => {
    if (prefs.mode === 'hotseat') {
      const decks = [deckCards(prefs.deck), deckCards(prefs.deck2)];
      if (!decks.every(legal)) return;
      hide('setup'); hide('menuBg');
      onPlay({ mode: 'hotseat', decks: decks.map((d) => d.slice()) });
      return;
    }
    const deck = deckCards(prefs.deck);
    if (!legal(deck)) return;
    hide('setup'); hide('menuBg');
    onPlay({ mode: 'bot', level: prefs.level, deck: deck.slice() });
  };

  // ---------- online rooms (the room server owns the match; play.js wires net.js in) ----------
  $('roomCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    $('joinRoom').classList.toggle('pulse', e.target.value.length === 5);
    renderCode();
  });
  $('roomCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinRoom').click(); });
  $('roomCode').addEventListener('focus', () => $('codeBoxes').classList.add('focus'));
  $('roomCode').addEventListener('blur', () => $('codeBoxes').classList.remove('focus'));
  $('createRoom').onclick = async () => {
    if (!online) return;
    note('');
    room = { code: null, opponent: null, host: true };
    renderSetup();
    try { await online.create(deckCards(prefs.deck)); } catch (err) { room = null; fail(err.message || 'Could not reach the room server.'); renderSetup(); }
  };
  $('joinRoom').onclick = async () => {
    const code = $('roomCode').value.trim();
    if (!online || code.length < 5) { fail('Type the 5 letter room code first.'); $('roomCode').focus(); return; }
    note('');
    $('joinRoom').classList.remove('pulse');
    room = { code, opponent: null, host: false };
    renderSetup();
    try { await online.join(code, deckCards(prefs.deck)); } catch (err) { room = null; fail(err.message || 'Could not join that room.'); renderSetup(); }
  };
  // the invite link opens the game straight on this panel with the code filled in (play.html?join=CODE)
  $('copyLink').onclick = async () => {
    if (!room?.code) return;
    const url = `${location.origin}${location.pathname}?join=${room.code}`;
    let done = false;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Latent Legends', text: 'Play me in Latent Legends', url }); done = true; } catch {}
    }
    if (!done) { try { await navigator.clipboard.writeText(url); done = true; } catch {} }
    if (!done) { note(url); return; }
    $('copyLbl').src = `${uiArt(`lbl_link_copied`)}`;
    clearTimeout($('copyLink').timer);
    $('copyLink').timer = setTimeout(() => { $('copyLbl').src = `${uiArt(`lbl_copy_invite_link`)}`; }, 2200);
  };
  $('cancelRoom').onclick = () => leaveRoom();
  function leaveRoom() { online?.cancel(); room = null; renderSetup(); }
  // a plain note follows the room's state; an error stays until the next action
  function note(text) { $('netNote').textContent = text; delete $('netNote').dataset.err; }
  function fail(text) { $('netNote').textContent = text; $('netNote').dataset.err = '1'; }

  // ---------- deck builder ----------
  function openBuilder() {
    work = (custom ?? deckCards(prefs.deck)).slice();
    filter = 'all';
    buildPool();
    renderBuilder();
    hide('setup'); show('builder');
  }

  let slots = {};
  function buildPool() {
    if (Object.keys(slots).length) return;
    const pool = $('pool');
    for (const id of [...POOL].sort(byCost)) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.dataset.id = id;
      const sc = document.createElement('div');
      sc.className = 'scaler';
      sc.appendChild(cardEl(id));
      s.appendChild(sc);
      if (NEW_CARDS.includes(id)) s.insertAdjacentHTML('beforeend', `<img class="new-badge" src="${uiArt(`badge_new`)}" alt="NEW" data-fail="remove">`);
      s.insertAdjacentHTML('beforeend', `<div class="pips">${Array.from({ length: DECK_RULES.maxCopies }, () => `<i></i>`).join('')}</div>`);
      s.onclick = () => add(id, s);
      s.oncontextmenu = (e) => { e.preventDefault(); remove(id); };
      pool.appendChild(s);
      slots[id] = s;
    }
  }

  const count = (id) => work.filter((x) => x === id).length;
  function add(id, from) {
    if (count(id) >= DECK_RULES.maxCopies || work.length >= DECK_RULES.size) { nudge(from); return; }
    work.push(id);
    renderBuilder(id);
    fly(from);
  }
  function remove(id) {
    const i = work.lastIndexOf(id);
    if (i < 0) return;
    work.splice(i, 1);
    renderBuilder();
  }
  function nudge(el) { el.classList.remove('no'); void el.offsetWidth; el.classList.add('no'); }

  // the card's art flies from the pool into the deck list
  function fly(from) {
    const art = from.querySelector('.art img');
    const to = $('deckCount');
    if (!art || !to) return;
    const st = $('stage').getBoundingClientRect(), s = st.width / 1920;
    const a = art.getBoundingClientRect(), b = to.getBoundingClientRect();
    const g = art.cloneNode();
    g.className = 'ghost';
    Object.assign(g.style, { left: `${(a.left - st.left) / s}px`, top: `${(a.top - st.top) / s}px`, width: `${a.width / s}px`, height: `${a.height / s}px` });
    $('builder').appendChild(g);
    const dx = (b.left + b.width / 2 - a.left - a.width / 2) / s, dy = (b.top + b.height / 2 - a.top - a.height / 2) / s;
    g.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.25)`, opacity: 0.2 }],
      { duration: 380, easing: 'cubic-bezier(.5, 0, .7, 1)' }).onfinish = () => g.remove();
  }

  function renderBuilder(added = null) {
    document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
    document.querySelectorAll('#builderEls button').forEach((b) => b.classList.toggle('on', b.dataset.el === elFilter));
    for (const [id, s] of Object.entries(slots)) {
      const n = count(id);
      s.classList.toggle('hidden', !FILTERS[filter](db[id]) || (!!elFilter && db[id].element !== elFilter));
      s.classList.toggle('max', n >= DECK_RULES.maxCopies);
      s.classList.toggle('in', n > 0);
      s.querySelectorAll('.pips i').forEach((p, i) => p.classList.toggle('on', i < n));
    }
    $('deckCount').innerHTML = numImg(`${work.length}/${DECK_RULES.size}`);
    $('deckCount').classList.toggle('full', work.length === DECK_RULES.size);

    const ids = [...new Set(work)].sort(byCost);
    $('deckRows').innerHTML = ids.map((id) => {
      const c = db[id], el = (c.element || '').toLowerCase();
      const gem = c.type === 'joker' ? 'gem_joker' : ['fire', 'frost', 'wild', 'storm', 'shadow'].includes(el) ? `gem_${el}` : 'gem_gold';
      return `<li data-id="${id}" class="${id === added ? 'pop' : ''}" title="Remove one"><span class="gem"><img src="${uiArt(`${gem}`)}" alt="">${numImg(c.cost)}</span>
        <img class="nm" src="${uiArt(`name_${id}`)}" alt="${c.name}"><span class="n">${numImg(`x${count(id)}`)}</span></li>`;
    }).join('') || '<li class="empty">Click cards on the left to add them.</li>';

    const st = deckStats(db, work);
    const top = Math.max(...POOL.map((id) => db[id].cost ?? 0));
    const peak = Math.max(4, ...st.curve);
    $('curve').innerHTML = st.curve.slice(0, top + 1).map((n, cost) =>
      `<div class="col"><span class="v">${n ? numImg(n) : ''}</span><i style="height:${Math.round((n / peak) * 76)}px"></i><span class="c">${numImg(cost)}</span></div>`).join('');
    $('counts').innerHTML = `<span>${label('units', 'Units')}${numImg(st.units)}</span><span>${label('spells', 'Spells')}${numImg(st.spells)}</span><span>${label('jokers', 'Jokers')}${numImg(st.jokers)}</span>`;

    const v = validateDeck(db, work);
    $('deckErrors').innerHTML = v.ok ? '<li class="ok">Ready to play.</li>' : v.errors.slice(0, 3).map((e) => `<li>${e}</li>`).join('');
    $('saveDeck').disabled = !v.ok;
  }

  $('filters').onclick = (e) => { const b = e.target.closest('button'); if (b) { filter = b.dataset.filter; renderBuilder(); } };
  // one element at a time; the same one again shows them all
  $('builderEls').onclick = (e) => { const b = e.target.closest('button'); if (b) { elFilter = elFilter === b.dataset.el ? null : b.dataset.el; renderBuilder(); } };
  $('deckRows').onclick = (e) => { const li = e.target.closest('li[data-id]'); if (li) remove(li.dataset.id); };
  $('starters').onclick = (e) => { const b = e.target.closest('button'); if (b) { work = STARTERS[b.dataset.starter].cards.slice(); renderBuilder(); } };
  $('clearDeck').onclick = () => { work = []; renderBuilder(); };
  $('builderBack').onclick = () => { hide('builder'); show('setup'); renderSetup(); };
  $('saveDeck').onclick = () => {
    if (!legal(work)) return;
    custom = work.slice();
    store.set('latent.deck', custom);
    prefs[deckKey()] = 'custom'; savePrefs();
    hide('builder'); show('setup'); renderSetup();
  };
  $('starters').innerHTML = Object.entries(STARTERS).map(([k, d]) => `<button data-starter="${k}">${deckName(k, d.name)}</button>`).join('');

  // ---------- the card book, and the note about the new cards ----------
  const book = createBook({ db, cardEl, numImg, clipOf, vfxOf, sound, show, hide });
  $('cardsBtn').onclick = () => { onAudio?.(); book.open({ from: 'start' }); };
  // once, for a returning player (a new player meets every card as new anyway)
  if (!store.get('latent.newcards', false) && (store.get('latent.offered', false) || store.get('latent.trained', false) || store.get('latent.setup', null))) {
    $('newCards').classList.remove('hidden');
  }
  const seenNew = () => { store.set('latent.newcards', true); $('newCards').classList.add('hidden'); };
  $('newLater').onclick = seenNew;
  $('newSee').onclick = () => { seenNew(); onAudio?.(); book.open({ from: 'start', onlyNewCards: true }); };

  // ---------- title ----------
  // the first PLAY offers the training match once; it stays one tap away on the setup screen
  $('startBtn').onclick = () => {
    onAudio?.();
    if (!store.get('latent.trained', false) && !store.get('latent.offered', false)) { store.set('latent.offered', true); $('trainOffer').classList.remove('hidden'); return; }
    hide('start'); show('setup'); renderSetup();
  };
  $('offerYes').onclick = () => { $('trainOffer').classList.add('hidden'); startTraining(); };
  $('offerNo').onclick = () => { $('trainOffer').classList.add('hidden'); hide('start'); show('setup'); renderSetup(); };
  $('setupTrain').onclick = () => { if (room) leaveRoom(); startTraining(); };
  function startTraining() { hide('start'); hide('setup'); hide('menuBg'); onPlay({ mode: 'training' }); }

  return {
    // back from a finished match: the backdrop and the setup come back
    openSetup() { show('menuBg'); show('setup'); renderSetup(); },
    // the room server's news for the setup screen: { code } once created, { opponent } once someone joins
    room(update) { if (!room) return; Object.assign(room, update); renderSetup(); },
    roomFailed(text) { room = null; fail(text); renderSetup(); },
    // an invite link (play.html?join=CODE): the setup opens on the online panel with the code filled in, one tap to join
    joinLink(code) {
      prefs.mode = 'online';
      hide('start'); show('setup');
      $('roomCode').value = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      renderSetup();
      $('joinRoom').classList.add('pulse');
      fail('Pick a deck on the right, then tap JOIN.');
    },
    leaveForMatch() { room = null; hide('setup'); hide('builder'); hide('start'); hide('menuBg'); },
    prefs: () => ({ ...prefs, cards: deckCards(prefs.deck).slice() }),
    prepare,
    // debug: ?screen=setup, ?screen=builder or ?screen=book opens that screen at load
    open(name) {
      if (name === 'book') return book.open({ from: 'start' });
      hide('start'); if (name === 'builder') { openBuilder(); } else { show('setup'); renderSetup(); }
    },
    setOnline(o) { online = o; renderSetup(); },
  };
}
