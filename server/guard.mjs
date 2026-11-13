// Checks on what a client sends, shared by server/rooms.mjs and cloudflare/worker.js. Everything here is safe to call
// with any JSON value: nothing throws, however deep, long or strange the input is.

// an action is a small flat object: strings, numbers, booleans, and one level of objects or arrays of those
// (rules.js legalActions: { t: 'play', id, target: { lane, slot } }, { slot, lanes: [a, b] }). Anything else is not
// an action, and is refused before the deep compare that would choke on it
export function actionShape(a) {
  let budget = 24;
  const leaf = (v) => (typeof v === 'string' && v.length <= 32) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
  const ok = (v, depth) => {
    if (--budget < 0) return false;
    if (leaf(v)) return true;
    if (depth === 0 || !v || typeof v !== 'object') return false;
    const vals = Array.isArray(v) ? v : Object.getPrototypeOf(v) === Object.prototype ? Object.values(v) : null;
    return !!vals && vals.length <= 8 && vals.every((x) => ok(x, depth - 1));
  };
  return !!a && typeof a === 'object' && !Array.isArray(a) && ok(a, 2);
}

// player names: no control, bidi or zero width characters (they let one name pass for another), no angle brackets
const STRIP = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ<>]/g;
export const cleanName = (n, fallback = 'Player') => (typeof n === 'string' ? n.slice(0, 64).replace(STRIP, '').replace(/\s+/g, ' ').trim().slice(0, 24) : '') || fallback;

// a constant time compare of two tokens, on their bytes
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 64) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// a ping's t is echoed back only when it is a number
export const pingT = (t) => (typeof t === 'number' && Number.isFinite(t) ? { t } : {});

// the key the limits per address count under: an IPv4 address, or the /64 network of an IPv6 one (one home or phone
// gets a whole /64, so counting single IPv6 addresses would let one client look like millions)
export function ipKey(ip) {
  if (typeof ip !== 'string' || !ip) return '';
  if (!ip.includes(':')) return ip.slice(0, 15);
  const v4 = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1];
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
