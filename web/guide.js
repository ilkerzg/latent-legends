// Latent Legends, the help for new players: a five step tour of the board before the first match (skippable, once)
// and the coach of the training match, which points at the next thing to do until the basics are done.
// Sentences are set in the body font on the panel image; the buttons and the pointer arrow are image art.
const $ = (id) => document.getElementById(id);
import { uiArt } from './uiart.js';
const label = (key, alt) => `<img class="lbl" src="${uiArt(`lbl_${key}`)}" alt="${alt}">`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// where things are, in stage px (the 1920x1080 stage is scaled to the window)
function stageRect(el) {
  const st = $('stage').getBoundingClientRect(), k = st.width / 1920, r = el.getBoundingClientRect();
  return { x: (r.left - st.left) / k, y: (r.top - st.top) / k, w: r.width / k, h: r.height / k };
}

// the box round all of an element's children (the hand is an empty box holding absolutely placed cards)
function childrenRect(el, fallback) {
  const rs = [...el.children].map(stageRect).filter((r) => r.w > 0 && r.h > 0);
  if (!rs.length) return fallback;
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.min(1080, Math.max(...rs.map((r) => r.y + r.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const handRect = () => childrenRect($('hand'), { x: 560, y: 800, w: 800, h: 270 });

// shrines(): the enemy Shrines' box in stage px, from play.js (they are drawn on the canvas, not in the DOM)
export function createGuide({ shrines }) {
  const root = document.createElement('div');
  root.id = 'guide';
  root.className = 'guide hidden';
  root.innerHTML = `<div class="spot"></div><img class="arrow" src="${uiArt(`hint_arrow`)}" alt="" data-fail="remove">
    <div class="bubble"><p></p><div class="btns"><button class="wide grey" data-g="skip">${label('skip_tour', 'SKIP TOUR')}</button>
    <button class="wide green" data-g="next">${label('next', 'NEXT')}</button></div><i class="count"></i></div>`;
  $('stage').append(root);
  const spot = root.querySelector('.spot'), bubble = root.querySelector('.bubble'), arrow = root.querySelector('.arrow');

  const TOUR = [
    { at: handRect, side: 'above', text: 'These are your cards. Drag one onto a glowing ring on your side to play it.' },
    { at: () => stageRect($('essence')), side: 'right', text: 'Essence pays for cards. You get more of it every turn.' },
    { at: () => shrines(), side: 'below', text: 'Every lane ends in an enemy Shrine. Break two of them to win.' },
    { at: () => stageRect($('endBtn')), side: 'left', text: 'Done with your cards? Tap here. Your units then fight, lane by lane.' },
    { at: () => stageRect($('log')), side: 'right', text: 'Every move of the match is written here, yours and the enemy\'s.' },
  ];

  // place the spotlight on r and the panel on one side of it, kept inside the stage
  function point(r, side, text, { count = '', buttons = true, dim = true } = {}) {
    const pad = 14;
    Object.assign(spot.style, { left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.w + pad * 2}px`, height: `${r.h + pad * 2}px` });
    root.classList.toggle('dim', dim);
    root.classList.toggle('coach', !buttons);
    bubble.querySelector('p').textContent = text;
    bubble.querySelector('.count').textContent = count;
    bubble.querySelector('.btns').classList.toggle('hidden', !buttons);
    const bw = buttons ? 620 : 520, bh = bubble.offsetHeight || 200;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let x = cx - bw / 2, y = side === 'above' ? r.y - bh - 90 : r.y + r.h + 90, ax = cx - 40, ay = side === 'above' ? r.y - 92 : r.y + r.h + 8, rot = side === 'above' ? 0 : 180;
    if (side === 'left') { x = r.x - bw - 110; y = cy - bh / 2; ax = r.x - 96; ay = cy - 40; rot = -90; }
    if (side === 'right') { x = r.x + r.w + 110; y = cy - bh / 2; ax = r.x + r.w + 16; ay = cy - 40; rot = 90; }
    x = Math.max(24, Math.min(1920 - bw - 24, x)); y = Math.max(24, Math.min(1080 - bh - 24, y));
    Object.assign(bubble.style, { left: `${x}px`, top: `${y}px`, width: `${bw}px` });
    Object.assign(arrow.style, { left: `${ax}px`, top: `${ay}px`, rotate: `${rot}deg` });
  }

  let tourDone = store.get('latent.tour') === 'done';
  return {
    needsTour: () => !tourDone,
    // the board tour: resolves when the last step is read or SKIP TOUR is pressed
    tour() {
      return new Promise((resolve) => {
        let i = 0;
        // placed again a few times a second: the cards are still being dealt when the tour opens
        const place = () => { const t = TOUR[i]; point(t.at(), t.side, t.text, { count: `${i + 1} / ${TOUR.length}` }); };
        const step = () => {
          root.querySelector('[data-g="next"]').innerHTML = i === TOUR.length - 1 ? label('got_it', 'GOT IT') : label('next', 'NEXT');
          place();
        };
        const follow = setInterval(place, 250);
        const end = () => {
          clearInterval(follow);
          tourDone = true; store.set('latent.tour', 'done');
          root.classList.add('hidden'); root.onclick = null;
          resolve();
        };
        root.onclick = (e) => {
          const g = e.target.closest('[data-g]')?.dataset.g;
          if (g === 'skip') end();
          else if (g === 'next') { if (++i >= TOUR.length) end(); else step(); }
        };
        root.classList.remove('hidden');
        step();
      });
    },
    // the training coach: point at the next thing to do (null hides it); never blocks the board
    coach(tip) {
      if (!tip) { if (root.classList.contains('coach')) root.classList.add('hidden'); return; }
      const key = `${tip.text}|${tip.side}`;
      root.classList.remove('hidden');
      if (root.dataset.tip === key) return;
      root.dataset.tip = key;
      clearInterval(this.follow);
      const place = () => point(tip.at(), tip.side, tip.text, { buttons: false, dim: false });
      place();
      this.follow = setInterval(() => { if (root.classList.contains('hidden')) clearInterval(this.follow); else place(); }, 250);
    },
    rect: stageRect,
  };
}
