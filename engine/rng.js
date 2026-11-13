// mulberry32 on a numeric seed kept inside the state, so a cloned state replays the same draws
export function next(holder) {
  let t = (holder.rng = (holder.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function shuffle(holder, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next(holder) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
