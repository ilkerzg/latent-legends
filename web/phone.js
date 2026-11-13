// Latent Legends is optimized for a desktop screen for now, so a phone gets a short notice (phone.html) in place of the game.
// A plain script, first in <head>: the page is replaced before the game's files are requested.
// A phone is a touch device whose shorter screen side is under 600 px; tablets and touch laptops play as usual.
(() => {
  const small = Math.min(screen.width, screen.height) < 600;
  if (small && matchMedia('(pointer: coarse)').matches) location.replace('phone.html');
})();
