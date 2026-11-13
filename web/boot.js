// Latent Legends boot. A plain script in <head>, so it runs before the page draws anything:
// 1. It fits the 1920x1080 stage to the window at once (play.js keeps it fitted later), so nothing jumps when the game
//    module starts.
// 2. It runs the loading screen (#boot in play.html). play.js reports every file it waits on through __boot.track() and
//    calls __boot.done() once the title has what it needs. Then the bar goes, the logo rises into its place on the title,
//    the key art comes up behind it and the title's buttons land.
(function () {
  const W = 1920, H = 1080, root = document.documentElement;
  // the same whole device pixel scale as play.js fit()
  function fit() {
    const d = window.devicePixelRatio || 1;
    const s = Math.max(1, Math.floor(Math.min(innerWidth / W, innerHeight / H) * d * 120)) / (d * 120);
    const x = Math.round(((innerWidth - W * s) / 2) * d) / d, y = Math.round(((innerHeight - H * s) / 2) * d) / d;
    root.style.setProperty('--fit', `translate(${x}px, ${y}px) scale(${s})`);
  }
  fit();
  addEventListener('resize', fit);
  root.classList.add('booting');

  // the pages carry no inline handlers (the site's Content-Security-Policy forbids them). An image says what happens
  // when it fails with data-fail: span or b put its alt text in its place, text puts the bare words, remove drops it.
  // data-in adds the class "in" once it has loaded. RELOAD on the loading screen reloads the page.
  addEventListener('error', (e) => {
    const im = e.target, how = im instanceof HTMLImageElement ? im.dataset.fail : null;
    if (!how) return;
    if (how === 'remove') im.remove();
    else im.replaceWith(how === 'text' ? im.alt : Object.assign(document.createElement(how === 'b' ? 'b' : 'span'), { textContent: im.alt }));
  }, true);
  addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement && 'in' in e.target.dataset) e.target.classList.add('in'); }, true);
  addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('#bootReload')) location.reload(); });

  const $ = (id) => document.getElementById(id);
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let want = 0, got = 0, shown = 0, ready = false, over = false;
  // time on the document timeline, so the bar keeps pace with the page's animations
  const clock = () => document.timeline?.currentTime ?? performance.now();
  const t0 = clock();
  let last = t0;
  // the bar never stands still: it creeps a little while the game's code is still arriving, follows the files after
  // that, and only the last stretch waits for done()
  function tick() {
    const now = clock(), dt = Math.min(100, now - last);
    last = now;
    const real = want ? got / want : 0;
    const creep = 0.16 * (1 - Math.exp(-(now - t0) / 900));
    const target = ready ? 1 : Math.max(creep, Math.min(0.92, real * 0.92));
    shown += (target - shown) * (1 - Math.exp(-dt / (ready ? 70 : 220)));
    const boot = $('boot');
    if (boot) {
      boot.style.setProperty('--p', shown.toFixed(4));
      const pct = $('bootPct');
      if (pct) pct.textContent = `${Math.round(shown * 100)}%`;
    }
    if (ready && shown > 0.995) { reveal(); return; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__boot = {
    track(p) {
      if (over) return p;
      want++;
      Promise.resolve(p).finally(() => { got++; });
      return p;
    },
    done() { ready = true; },
  };
  // the loader only lifts once the game is wired up, never on a timer: a title whose buttons do nothing is worse than a
  // wait. A slow load says so, and a load that breaks offers a reload.
  const say = (text) => {
    const m = $('bootMsg');
    if (!m || over) return;
    m.textContent = text;
    m.hidden = false;
    $('bootReload').hidden = false;
  };
  setTimeout(() => { if (!ready) say('Loading is taking longer than usual.'); }, 25000);
  addEventListener('error', () => { if (!ready) say('The game could not load.'); });
  addEventListener('unhandledrejection', () => { if (!ready) say('The game could not load.'); });

  function reveal() {
    if (over) return;
    over = true;
    const boot = $('boot'), start = $('start'), bg = $('menuBg');
    if (!boot) { root.classList.remove('booting'); return; }
    // from here the page under the loader takes the clicks, and the loader is removed on a timer as well as when its
    // animation ends, so it can never stay over the game unseen
    boot.classList.add('lifting');
    const gone = (after) => { let once = false; return () => { if (once) return; once = true; boot.remove(); after?.(); }; };
    const titleOn = start && !start.matches('.hidden, .leave') && bg && !bg.matches('.hidden, .leave');
    // straight into a match or another screen (?mode=, ?screen=, ?join=): the loader just fades
    if (!titleOn || calm) {
      root.classList.remove('booting');
      const end = gone();
      boot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: calm ? 200 : 420, easing: 'ease-out', fill: 'forwards' }).finished.then(end, end);
      setTimeout(end, 700);
      return;
    }
    // the logo flies from the loader to the title logo's box, measured in stage px
    const stage = $('stage').getBoundingClientRect(), k = stage.width / W;
    const from = boot.querySelector('.logo').getBoundingClientRect(), to = start.querySelector('.logo').getBoundingClientRect();
    const dx = (to.left + to.width / 2 - from.left - from.width / 2) / k, dy = (to.top + to.height / 2 - from.top - from.height / 2) / k;
    const sc = to.width / from.width;
    // the title's parts land one after another once the logo is on its way (play.css .title.opening)
    [...start.children].filter((c) => c.offsetParent && !c.matches('.logo, .offer')).forEach((c, i) => c.style.setProperty('--k', i));
    start.classList.add('opening');
    bg.classList.add('opening');
    root.classList.remove('booting');
    boot.querySelector('.load').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(26px) scale(.94)' }],
      { duration: 280, easing: 'cubic-bezier(.5, 0, .75, 0)', fill: 'forwards' });
    boot.querySelector('.veil').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, delay: 220, easing: 'cubic-bezier(.3, 0, .2, 1)', fill: 'forwards' });
    // the title's own logo takes over when the flight ends, floating, without its drop
    const end = gone(() => {
      start.classList.add('landed');
      setTimeout(() => { start.classList.remove('opening'); bg.classList.remove('opening'); }, 1400);
    });
    boot.querySelector('.logo').animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${sc})` }],
      { duration: 820, delay: 140, easing: 'cubic-bezier(.6, 0, .2, 1)', fill: 'forwards' }).finished.then(end, end);
    setTimeout(end, 1200);
  }
})();
