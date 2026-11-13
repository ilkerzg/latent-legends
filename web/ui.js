// Latent Legends UI: everything outside the canvas. play.js owns the match and the board;
// this module owns the hand, the HUD, the banners, the enemy card reveal, the unit tooltip and the title and game over screens.
// Every position here is in stage px (the fixed 1920x1080 stage that play.js scales to the window).

const $ = (id) => document.getElementById(id);
import { uiArt } from './uiart.js';

// numbers, card names and fixed words are lettering images, not a web font
const GLYPH = { '/': 'slash', '+': 'plus', x: 'x' };
export const numImg = (v) => `<i class="num">${String(v).split('').map((ch) => `<img src="${uiArt(`num_${GLYPH[ch] ?? ch}`)}" alt="${ch}">`).join('')}</i>`;
const label = (key, alt) => `<img class="lbl" src="${uiArt(`lbl_${key}`)}" alt="${alt}">`;
const nameImg = (id, name) => `<img class="nmimg" src="${uiArt(`name_${id}`)}" alt="${name}" data-fail="span">`;
const KEYWORDS = /\b(Taunt|Dive|Blast|Snipe|Siphon|Burn|burn|Freeze|freeze|Frozen|Armor|Ward|Essence|magic|physical)\b/g;

// an animation's end, or its planned length in wall time: a hidden tab never finishes WAAPI animations,
// and the match must not wait on one forever
const settle = (anim, dur) => Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, dur + 150))]);

export function createUI(api) {
  const { db } = api;
  const ms = (t) => t / api.speed();                    // UI motion follows the game speed
  let handIds = [], cardEls = [], hover = -1, drag = null, flying = false;
  let last = { essence: null, enemyHand: null, enemyDeck: null, myDeck: null };
  const stats = { played: 0 };

  // ---------- stage geometry ----------
  function stageScale() { return $('stage').getBoundingClientRect().width / 1920; }
  function clientToStage(cx, cy) {
    const r = $('stage').getBoundingClientRect(), s = r.width / 1920;
    return [(cx - r.left) / s, (cy - r.top) / s];
  }

  // ---------- one card, as a DOM element ----------
  // the elements with their own frame, spell frame, cost gem and icon
  const ELEMENT_ART = ['fire', 'frost', 'wild', 'storm', 'shadow'];
  function cardEl(id) {
    const c = db[id];
    const kind = c.type === 'unit' || c.type === 'token' ? 'unit' : c.type === 'joker' ? 'joker' : 'spell';
    const el = (c.element || '').toLowerCase();
    const known = ELEMENT_ART.includes(el);
    const frame = kind === 'joker' ? 'card_joker' : kind === 'spell' ? (known ? `spell_${el}` : 'spell_fire') : known ? `card_${el}` : 'card_neutral';
    const gem = kind === 'joker' ? 'gem_joker' : known ? `gem_${el}` : 'gem_gold';
    const art = api.hasArt(id) ? `<img src="assets/portraits/${id}.webp" alt="">`
      : `<div class="glyph" style="background:radial-gradient(circle at 50% 40%, ${api.ecol(c.element)}88, #120d1c 75%)">${c.name.split(' ').map((w) => w[0]).join('')}</div>`;
    const text = (kind === 'unit' ? c.skill?.text ?? (c.type === 'token' ? 'A wall. It never acts.' : '') : c.text)
      .replace(/^\[(\d+|X)\]\s*/, '<span class="mana">$1 Mana</span> ')
      .replace(KEYWORDS, '<b>$1</b>');
    const role = kind === 'unit' && c.role && c.role !== 'Wall' ? `<div class="role"><img src="${uiArt(`role_${c.role.toLowerCase()}`)}" alt=""></div>` : '';
    const stats = kind === 'unit' ? `
      <div class="st atk"><img src="${uiArt(`badge_atk`)}" alt=""><b>${numImg(c.atk)}</b></div>
      <div class="st hp"><img src="${uiArt(`badge_hp`)}" alt=""><b>${numImg(c.hp)}</b></div>
      ${c.armor ? `<div class="st ar"><img src="${uiArt(`badge_armor`)}" alt=""><b>${numImg(c.armor)}</b></div>` : ''}
      ${c.ward ? `<div class="st wd"><img src="${uiArt(`badge_ward`)}" alt=""><b>${numImg(c.ward)}</b></div>` : ''}` : '';
    const d = document.createElement('div');
    d.className = `card ${kind} ${el}`;
    // the element as a shape too, under the cost gem where it shows in a fanned hand: frame colours alone fail colour blind eyes
    const elIcon = known && kind !== 'joker' ? `<img class="elico" src="${uiArt(`el_${el}`)}" alt="${c.element}">` : '';
    d.innerHTML = `<img class="glow" src="${uiArt(`glow_${frame}`)}?v=3" alt=""><div class="art">${art}</div><img class="frame" src="${uiArt(`${frame}`)}" alt="">
      <div class="gem"><img src="${uiArt(`${gem}`)}" alt=""><b>${numImg(c.cost)}</b></div>${elIcon}${role}
      <div class="nm">${nameImg(id, c.name)}</div><div class="txt"><div>${text}</div></div>${stats}<div class="shine"></div>`;
    fitText(d, id);
    return d;
  }

  // rules text shrinks until it fits its panel: measured once per card in a hidden box, then remembered
  const fitSize = {};
  function fitText(d, id) {
    const box = d.querySelector('.txt'), inner = box.firstElementChild;
    if (fitSize[id] !== undefined) { box.style.fontSize = fitSize[id]; return; }
    let probe = $('measure');
    if (!probe) { probe = document.createElement('div'); probe.id = 'measure'; $('stage').append(probe); }
    probe.append(d);
    let px = 11.5;
    while ((inner.scrollHeight > box.clientHeight || inner.scrollWidth > box.clientWidth) && px > 8) { px -= 0.5; box.style.fontSize = `${px}px`; }
    d.remove();
    // only remember once the web fonts are in, or the sizes were measured on the fallback font
    if (document.fonts.status === 'loaded') fitSize[id] = box.style.fontSize;
  }

  // ---------- the hand: a fan, hover lift, drag and drop ----------
  function layout() {
    const n = cardEls.length;
    if (!n) return;
    const cw = 200, ch = 286;
    const spacing = Math.min(150, 820 / Math.max(1, n - 1));
    const step = Math.min(5, 26 / Math.max(1, n - 1));
    cardEls.forEach((el, i) => {
      if (drag?.el === el || el.classList.contains('gone')) return;
      const off = i - (n - 1) / 2;
      let x = off * spacing - cw / 2, y = -ch * 0.7 + off * off * 5, rot = off * step, sc = 1, z = 10 + i;
      if (hover >= 0 && hover !== i) x += Math.sign(i - hover) * (n > 6 ? 70 : 90) / Math.max(1, Math.abs(i - hover) * 0.8);
      if (hover === i) { y = -ch - 14; rot = 0; sc = 1.48; z = 40; }
      // a picked card rises less than a hovered one, so the back-row slots behind it stay clickable
      if (el.classList.contains('sel')) { y = -ch * 0.84; rot = 0; sc = 1.06; z = 39; }
      el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${sc})`;
      el.style.zIndex = z;
    });
  }

  function renderHand() {
    // the card drawn for the next turn is dealt with that turn's banner, not while the last action still plays
    if (api.shown()) return;
    const S = api.S();
    const hand = S.players[api.me()].hand;
    const legal = api.legalNow();
    const myMain = api.humanTurn() && !api.busy() && S.phase === 'main';
    const playable = new Set(legal.filter((a) => a.t === 'play').map((a) => a.id));
    const same = hand.length === handIds.length && hand.every((id, i) => id === handIds[i]);
    if (!same) {
      // keep the elements of cards still in hand so they glide; new ones are dealt in
      const box = $('hand');
      const pool = new Map();
      handIds.forEach((id, i) => { if (!cardEls[i].classList.contains('gone')) (pool.get(id) ?? pool.set(id, []).get(id)).push(cardEls[i]); });
      const next = hand.map((id) => {
        const reuse = pool.get(id)?.shift();
        if (reuse) return reuse;
        const el = cardEl(id);
        el.classList.add('new');
        el.addEventListener('animationend', () => el.classList.remove('new'), { once: true });
        box.append(el);
        return el;
      });
      for (const els of pool.values()) els.forEach((el) => el.remove());
      cardEls = next; handIds = hand.slice();
      cardEls.forEach((el, i) => wireCard(el, i));
    }
    const sel = api.getSel();
    cardEls.forEach((el, i) => {
      const can = myMain && playable.has(hand[i]);
      el.classList.toggle('playable', can);
      el.classList.toggle('dim', !can && api.humanTurn() && S.phase === 'main');
      el.classList.toggle('sel', sel?.kind === 'card' && sel.index === i);
    });
    if (hover >= cardEls.length) hover = -1;
    layout();
  }

  function wireCard(el, i) {
    el.onpointerenter = () => { if (!drag) { hover = i; layout(); } };
    el.onpointerleave = () => { if (!drag && hover === i) { hover = -1; layout(); } };
    el.onpointerdown = (e) => {
      if (!el.classList.contains('playable') || flying) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const [sx, sy] = clientToStage(e.clientX, e.clientY);
      drag = { el, i, id: handIds[i], sx, sy, moved: false, lastX: sx, vx: 0 };
    };
    el.onpointermove = (e) => {
      if (!drag || drag.el !== el) return;
      const [x, y] = clientToStage(e.clientX, e.clientY);
      if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) < 10) return;
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add('dragging');
        hover = -1;
        api.selectCard(drag.id, drag.i, { keep: true });       // light up the targets on the board
        layout();
      }
      drag.vx = drag.vx * 0.7 + (x - drag.lastX) * 0.3; drag.lastX = x;
      const tilt = Math.max(-18, Math.min(18, drag.vx * 0.9));
      // relative to the hand's origin (960, 1080)
      el.style.transform = `translate(${x - 960 - 100}px, ${y - 1080 - 160}px) rotate(${tilt}deg) scale(1.05)`;
      api.setHover(api.boardPos(e.clientX, e.clientY));
    };
    el.onpointerup = async (e) => {
      if (!drag || drag.el !== el) return;
      const d = drag; drag = null;
      el.classList.remove('dragging');
      if (!d.moved) { api.selectCard(d.id, d.i); return; }
      const p = api.boardPos(e.clientX, e.clientY);
      const t = api.pickTarget(p);
      const [, sy] = clientToStage(e.clientX, e.clientY);
      const sel = api.getSel();
      if (t && t.actions.length === 1) { await commitCard(t.actions[0], t.shape); return; }
      if (t) { openChooser(t); return; }
      // untargeted cards (Spark) play when dropped anywhere above the hand
      if (!sel?.targets?.length && sy < 820) {
        const a = api.legalNow().find((x) => x.t === 'play' && x.id === d.id);
        if (a) { await commitCard(a, null); return; }
      }
      api.clearSel();
      api.setHover(null);
      render();
    };
  }

  // the chosen card flies to its target, flares and is gone; then the engine takes the action
  async function commitCard(a, shape) {
    const i = handIds.indexOf(a.id);
    const el = cardEls[i];
    flying = true;
    stats.played++;
    api.clearSel();
    if (el) {
      const r = el.getBoundingClientRect();
      const [x0, y0] = clientToStage(r.left + r.width / 2, r.top + r.height / 2);
      const [tx, ty] = shape ? api.toCss(shape.x, shape.y - (shape.kind === 'lane' ? 0 : 60)) : [960, 470];
      el.classList.add('gone');
      $('fly').append(el);
      el.style.zIndex = 50;
      const s0 = r.width / stageScale() / 200;
      const k = el.animate([
        { transform: `translate(${x0 - 100}px, ${y0 - 143}px) scale(${s0})`, filter: 'brightness(1)' },
        { transform: `translate(${(x0 + tx) / 2 - 100}px, ${Math.min(y0, ty) - 260}px) scale(1.15) rotate(${tx > x0 ? 8 : -8}deg)`, filter: 'brightness(1.2)', offset: 0.45 },
        { transform: `translate(${tx - 100}px, ${ty - 143}px) scale(.32)`, filter: 'brightness(3)', opacity: 0.9 },
      ], { duration: ms(520), easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
      await settle(k, ms(520));
      flare(tx, ty, api.ecol(db[a.id]?.element));
      el.remove();
      cardEls.splice(i, 1); handIds.splice(i, 1);
      cardEls.forEach((c, j) => wireCard(c, j));
    }
    flying = false;
    api.choose(a);
  }

  // a quick DOM flash where a card lands (the canvas adds its own summon effects)
  function flare(x, y, col) {
    const f = document.createElement('div');
    f.style.cssText = `position:absolute;left:${x - 110}px;top:${y - 110}px;width:220px;height:220px;border-radius:50%;pointer-events:none;z-index:41;
      background:radial-gradient(circle, #fff 0%, ${col} 30%, transparent 70%);mix-blend-mode:screen`;
    $('fly').append(f);
    f.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: ms(450), easing: 'ease-out' }).finished.then(() => f.remove());
  }

  function openChooser(t) {
    const box = $('chooser');
    box.innerHTML = '';
    for (const a of t.actions) {
      const b = document.createElement('button');
      b.className = `wide ${{ Frost: 'blue', Storm: 'blue', Fire: 'orange', Shadow: 'grey' }[a.element] ?? 'green'}`;
      // Gust pushes, Swap trades places: the button is an arrow toward the lane it goes to
      const to = a.to ?? a.lanes?.find((l) => l !== t.shape.lane);
      const from = a.target?.lane ?? t.shape.lane;
      if (a.element) b.innerHTML = label(a.element.toLowerCase(), a.element);
      else if (to != null && from != null) {
        b.innerHTML = `<img class="dir" src="${uiArt(`hint_arrow`)}" alt="${to < from ? 'Left' : 'Right'}" style="rotate:${to < from ? 90 : -90}deg">`;
        b.title = to < from ? 'To the left lane' : 'To the right lane';
        // Swap may reach two lanes on the same side (an end unit pairs with both others): the partner's face tells them apart
        const partner = a.lanes ? api.S().board[to][api.S().active][a.slot] : null;
        if (partner && api.hasArt(partner.id)) {
          b.classList.add('with-face');
          b.insertAdjacentHTML('beforeend', `<img class="face" src="assets/portraits/${partner.id}.webp" alt="${partner.name}">`);
          b.title = `Swap with ${partner.name}`;
        }
      } else b.textContent = a.mode ?? 'Choose';
      b.onclick = (ev) => { ev.stopPropagation(); box.classList.add('hidden'); commitCard(a, t.shape); };
      box.append(b);
    }
    const [cx, cy] = api.toCss(t.shape.x, t.shape.y - 150 * t.shape.sr);
    box.style.left = `${cx}px`; box.style.top = `${cy}px`;
    box.classList.remove('hidden');
  }

  // ---------- HUD ----------
  function renderHud() {
    const S = api.S();
    const M = api.me(), me = S.players[M], foe = S.players[1 - M];
    // while an action plays out, the turn, phase and Essence shown are the ones from before it, until its TurnStart
    const T = api.shown() ?? { active: S.active, phase: S.phase, turn: S.turn, essence: S.players.map((p) => p.essence) };
    const mine = T.active === M;
    setHtml('turnNo', numImg(Math.max(1, T.turn[T.active] ?? 1)));
    const ph = S.phase === 'over' ? null : `${mine ? 'your' : 'enemy'}_${T.phase === 'main' ? 'move' : 'combat'}`;
    setHtml('phase', label(ph ?? 'game_over', ph ? ph.replace('_', ' ') : 'Game over'));
    $('turnPill').className = mine ? 'mine' : 'foe';

    // essence: orb number, pips with pop and spend animations
    const max = Math.min(Math.max(T.turn[M], 1), S.cfg.maxEssence);
    const ess = T.essence[M];
    if (last.essence !== null && ess !== last.essence) pulse($('essence').querySelector('.orb'), ess > last.essence ? 'gain' : 'spend');
    setHtml('essenceNum', numImg(ess));
    const pips = $('pips');
    const n = Math.max(max, ess);
    while (pips.children.length < n) { const im = document.createElement('img'); pips.append(im); }
    while (pips.children.length > n) pips.lastChild.remove();
    [...pips.children].forEach((im, i) => {
      const full = i < ess;
      if (im.classList.contains('full') !== full) {
        im.src = `${uiArt(`${full ? 'pip_full' : 'pip_empty'}`)}`;
        im.classList.toggle('full', full);
        if (full) pulse(im, 'pop');
      } else if (!im.src) im.src = `${uiArt(`pip_empty`)}`;
    });
    last.essence = ess;

    bumpText('myDeck', me.deck.length, 'myDeck');
    bumpText('enemyHand', foe.hand.length, 'enemyHand');
    bumpText('enemyDeck', foe.deck.length, 'enemyDeck');
    const eg = $('enemyGems'), emax = Math.min(Math.max(T.turn[1 - M], 1), S.cfg.maxEssence);
    eg.innerHTML = Array.from({ length: Math.max(emax, T.essence[1 - M]) }, (_, i) => `<img src="${uiArt(`mana_pip`)}" class="${i < (T.active !== M ? T.essence[1 - M] : 0) ? '' : 'off'}" alt="">`).join('');
    renderEnemyFan(foe.hand.length);

    // end turn button: ready in your main phase, grey in your combat, red on the enemy turn
    const btn = $('endBtn');
    const legal = api.legalNow();
    const myMain = api.humanTurn() && !api.busy() && S.phase === 'main';
    const state = S.phase === 'over' ? 'off' : myMain ? 'ready' : mine ? 'combat' : 'enemy';
    btn.className = `end ${state}`;
    btn.disabled = state !== 'ready';
    $('endImg').src = `${uiArt(`${state === 'ready' ? 'end_ready' : state === 'enemy' ? 'end_enemy' : 'end_off'}`)}`;
    const lk = state === 'ready' ? 'to_combat' : state === 'combat' ? 'combat' : state === 'enemy' ? 'enemy_turn' : 'wait';
    setHtml('endLabel', label(lk, lk.replace('_', ' ')));
    // nothing left to play: nudge the player toward the button
    if (state === 'ready' && !legal.some((a) => a.t === 'play')) btn.classList.add('urge');

    const sel = api.getSel();
    const actor = S.phase === 'combat' ? api.currentActor(S) : null;
    const shrineOnly = actor && !S.board[actor[1]][1 - actor[2]][0] && S.board[actor[1]][1 - actor[2]][1];
    const hint = !api.humanTurn() || api.busy() ? '' : S.phase === 'main'
      ? (sel ? 'Pick a glowing target. Right click cancels.' : '')
      : shrineOnly ? 'No enemy in front: Attack hits the Shrine. Only Skills reach the back row.'
      : 'Choose Attack or Skill for the glowing unit';
    $('hint').textContent = hint;
    $('hint').classList.toggle('show', !!hint);
  }

  function renderEnemyFan(n) {
    const fan = $('enemyHandFan');
    while (fan.children.length < n) { const b = document.createElement('div'); b.className = 'back'; fan.append(b); }
    while (fan.children.length > n) fan.lastChild.remove();
    [...fan.children].forEach((b, i) => {
      const off = i - (n - 1) / 2;
      b.style.transform = `translate(${off * 46 - 52}px, ${Math.abs(off) * 6}px) rotate(${-off * 6 + 180}deg)`;
    });
  }

  function bumpText(id, v, key) {
    const el = $(id);
    if (last[key] !== null && last[key] !== v) pulse(el.parentElement, 'bump');
    if (last[key] !== v) el.innerHTML = numImg(v);
    last[key] = v;
  }
  // only touch the DOM when the markup changes, so images are not reloaded every render
  function setHtml(id, html) { const el = $(id); if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }
  function pulse(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------- combat panel next to the acting unit ----------
  function renderPanel() {
    const S = api.S();
    const panel = $('actPanel');
    const legal = api.legalNow();
    if (!S || S.phase !== 'combat' || !legal.length) { panel.classList.add('hidden'); panel.dataset.uid = ''; return; }
    const [u, lane, side] = api.currentActor(S);
    if (panel.dataset.uid === String(u.uid) && !panel.classList.contains('hidden')) return;
    // Attack only ever reaches the enemy Front unit of this lane; with the Front empty it hits the Shrine,
    // even with an enemy in the Back row (only Skills reach that row). The button says which.
    const [front, back] = S.board[lane][1 - side];
    const attack = legal.find((a) => a.mode === 'attack');
    const skills = legal.filter((a) => a.mode === 'skill');
    const sk = u.skill;
    const cost = sk ? (sk.cost === 'X' ? `all ${u.mana}` : sk.cost) : 0;
    let reason = '';
    if (sk && !skills.length) reason = u.mana < (sk.cost === 'X' ? 1 : sk.cost) ? 'not enough Mana' : 'no target';
    panel.innerHTML = '';
    const b1 = document.createElement('button');
    b1.className = 'wide orange';
    b1.innerHTML = `${label('attack', 'Attack')}<small>${front ? `hits ${front.name}` : 'hits the Shrine'}</small>`;
    b1.title = front ? `Attack hits the enemy Front unit, ${front.name}.`
      : back ? 'No enemy in front, so Attack hits the Shrine. Only Skills reach the back row.' : 'No enemy in this lane: Attack hits the Shrine.';
    b1.onclick = () => api.choose(attack);
    const b2 = document.createElement('button');
    b2.className = `wide ${skills.length ? 'blue' : 'grey'}`;
    b2.innerHTML = sk ? `${label(sk.id, api.SKILL_NAME[sk.id] ?? sk.id)}<small>${reason || `${cost} Mana`}</small>` : label('no_skill', 'No skill');
    b2.disabled = !skills.length;
    b2.onclick = () => {
      if (skills.length === 1) api.choose(skills[0]);
      else { api.setSel({ kind: 'skill', targets: api.targetsFor(skills) }); render(); }
    };
    panel.append(b1, b2);
    panel.dataset.uid = u.uid;
    panel.classList.remove('hidden');
    positionPanel();
  }
  function positionPanel() {
    const panel = $('actPanel');
    if (panel.classList.contains('hidden')) return;
    const v = api.views().get(+panel.dataset.uid);
    if (!v) return;
    const [cx, cy] = api.toCss(v.x, v.y + 60 * v.sr);
    panel.style.left = `${cx}px`; panel.style.top = `${Math.min(cy, 800)}px`;
  }

  // ---------- unit tooltip: the unit's card plus its live state ----------
  function unitTip(v, f) {
    const tip = $('tip');
    if (!v || !f || drag) { tip.classList.add('hidden'); tip.dataset.uid = ''; return; }
    const u = f[0];
    if (tip.dataset.uid !== String(u.uid) || tip.classList.contains('hidden')) {
      tip.innerHTML = '';
      const c = cardEl(u.id);
      tip.append(c);
      const live = document.createElement('div');
      live.className = 'live';
      tip.append(live);
      tip.dataset.uid = u.uid;
    }
    const live = tip.querySelector('.live');
    live.innerHTML = `<span>HP ${u.hp}/${u.maxHp}</span><span>Mana ${u.mana}/${u.maxMana}</span>${u.armor ? `<span>Armor ${u.armor}</span>` : ''}${u.ward ? `<span>Ward ${u.ward}</span>` : ''}
      ${u.taunt ? '<span class="taunt">Taunting</span>' : ''}${u.frozen ? '<span class="frozen">Frozen</span>' : ''}${u.burn ? `<span class="burn">Burn ${u.burn}</span>` : ''}
      <span>${f[2] === api.me() ? 'Yours' : 'Enemy'}</span>`;
    // live numbers on the card itself
    const atk = tip.querySelector('.st.atk b'), hp = tip.querySelector('.st.hp b');
    if (atk) atk.innerHTML = numImg(u.atk);
    if (hp) { hp.innerHTML = numImg(u.hp); hp.classList.toggle('hurt', u.hp < u.maxHp); }
    const [cx, cy] = api.toCss(v.x, v.y);
    tip.style.left = `${cx > 960 ? cx - 330 : cx + 80}px`;
    tip.style.top = `${Math.max(70, Math.min(cy - 300, 560))}px`;
    tip.classList.remove('hidden');
  }

  // ---------- banners, feed, spell names ----------
  function banner(kind, sub = '') {
    const box = $('banner');
    box.innerHTML = '';
    const b = document.createElement('div');
    b.className = `b in${kind === 'combat' ? ' small' : ''}`;
    b.innerHTML = `<img src="${uiArt(`banner_${kind}`)}" alt="">${sub ? `<div class="sub">${sub}</div>` : ''}`;
    const f = document.createElement('div');
    f.className = 'flash';
    box.append(f, b);
    b.addEventListener('animationend', () => b.remove(), { once: true });
    f.addEventListener('animationend', () => f.remove(), { once: true });
  }
  // img: a lettering image (a card name or a label) shown instead of the text
  function spellName(text, x, y, color, img = null) {
    const d = document.createElement('div');
    d.className = 'spell-name stroke';
    if (img) d.innerHTML = `<img src="${uiArt(`${img}`)}" alt="${text}">`; else d.textContent = text;
    d.style.left = `${x}px`; d.style.top = `${y}px`; d.style.color = color;
    $('stage').append(d);
    d.addEventListener('animationend', () => d.remove(), { once: true });
  }
  // battle log: a plate per line (blue gem yours, red the enemy's, violet for turns and the Shrines),
  // the card's portrait in a gem frame with a badge for what happened, names picked out in colour
  const NAMES = [...new Set(Object.values(db).map((c) => c.name))].sort((a, b) => b.length - a.length);
  const NAME_RE = new RegExp(`\\b(${NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  function feed(text, cls = '', meta = {}) {
    const ol = $('log');
    const li = document.createElement('li');
    const side = cls === 'you' || cls === 'foe' ? cls : 'turn';
    li.className = side;
    const html = text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
      .replace(NAME_RE, '<b>$1</b>').replace(/^(You|Your)\b/, '<em class="you">$1</em>').replace(/^Enemy\b/, '<em class="foe">Enemy</em>');
    const icon = meta.icon ? `<img class="badge" src="${uiArt(`ico_${meta.icon}`)}" alt="">` : '';
    const pic = meta.card && api.hasArt(meta.card)
      ? `<span class="pf"><img class="art" src="assets/portraits/${meta.card}.webp" alt=""><img class="fr" src="${uiArt(`logframe_${side === 'foe' ? 'foe' : 'you'}`)}" alt="">${icon}</span>`
      : `<span class="pf solo">${icon}</span>`;
    li.innerHTML = `${pic}<span class="t">${html}</span>`;
    ol.append(li);
    while (ol.children.length > 6) ol.firstChild.remove();
    [...ol.children].forEach((x, i, all) => x.classList.toggle('old', i < all.length - 3));
  }

  // ---------- the enemy plays a card: it flips out of their hand, shows itself, then dives at its target ----------
  async function reveal(id, to) {
    const el = cardEl(id);
    el.classList.remove('playable');
    el.style.zIndex = 45;
    const back = document.createElement('img');
    back.src = `${uiArt(`card_back`)}`;
    back.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;backface-visibility:hidden;';
    el.append(back);
    $('fly').append(el);
    const [tx, ty] = to ?? [960, 420];
    const hold = [1340, 300];
    await settle(el.animate([
      { transform: 'translate(420px, -260px) scale(.5) rotate(180deg)' },
      { transform: `translate(${hold[0] - 100}px, ${hold[1] - 143}px) scale(1.25) rotate(-4deg)`, offset: 0.7 },
      { transform: `translate(${hold[0] - 100}px, ${hold[1] - 143}px) scale(1.18) rotate(0deg)` },
    ], { duration: ms(560), easing: 'cubic-bezier(.2, 1, .3, 1)', fill: 'forwards' }), ms(560));
    back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(160), fill: 'forwards' });
    await api.wait(700);
    await settle(el.animate([
      { transform: `translate(${hold[0] - 100}px, ${hold[1] - 143}px) scale(1.18)`, filter: 'brightness(1)' },
      { transform: `translate(${tx - 100}px, ${ty - 143}px) scale(.3)`, filter: 'brightness(3)', opacity: 0.85 },
    ], { duration: ms(380), easing: 'cubic-bezier(.5, 0, .8, .4)', fill: 'forwards' }), ms(380));
    flare(tx, ty, api.ecol(db[id]?.element));
    el.remove();
  }

  // ---------- title and game over ----------
  // names: the two sides' names for the Shrine counts in a hotseat match ([this side, the other]), else You/Enemy
  function over(winner, reason, names) {
    const S = api.S();
    const box = $('over');
    box.classList.toggle('defeat', winner !== 0);
    $('overImg').src = `${uiArt(`${winner === 'draw' ? 'lbl_draw' : winner === 0 ? 'banner_victory' : 'banner_defeat'}`)}`;
    $('overImg').classList.toggle('draw', winner === 'draw');
    $('overTitle').textContent = winner === 'draw' ? 'Draw' : winner === 0 ? 'Victory' : 'Defeat';
    $('overReason').textContent = reason;
    const M = api.me(), alive = (p) => S.players[p].shrines.filter((h) => h > 0).length;
    $('overStats').innerHTML = `<div><b>${numImg(S.turn[M])}</b><span>Turns</span></div><div><b>${numImg(stats.played)}</b><span>Cards played</span></div>
      <div><b>${numImg(`${alive(M)}/3`)}</b><span>${names ? `${names[0]} Shrines` : 'Your Shrines'}</span></div><div><b>${numImg(`${alive(1 - M)}/3`)}</b><span>${names ? `${names[1]} Shrines` : 'Enemy Shrines'}</span></div>`;
    box.classList.remove('hidden');
  }

  function reset() {
    $('againBtn').disabled = false;
    $('hand').innerHTML = ''; $('fly').innerHTML = ''; $('log').innerHTML = ''; $('banner').innerHTML = '';
    handIds = []; cardEls = []; hover = -1; drag = null; flying = false;
    last = { essence: null, enemyHand: null, enemyDeck: null, myDeck: null };
    stats.played = 0;
    $('over').classList.add('hidden');
    $('tip').classList.add('hidden');
  }

  // the board turned to the other seat (hotseat): forget what was last shown so nothing pulses as if it changed
  function resync() {
    last = { essence: null, enemyHand: null, enemyDeck: null, myDeck: null };
    handIds = []; cardEls = []; hover = -1; drag = null;
    $('hand').innerHTML = ''; $('tip').classList.add('hidden');
  }

  function render() {
    if (!api.S()) return;
    renderHud();
    renderHand();
    renderPanel();
  }

  // the title, the setup and the deck builder are menu.js; the game over screen sends you back there
  $('againBtn').onclick = () => api.restart();
  $('overBack').onclick = () => api.back();

  return { render, layout, feed, banner, spellName, reveal, over, reset, resync, positionPanel, unitTip, commitCard, openChooser, cardEl, isBusy: () => flying || !!drag };
}
