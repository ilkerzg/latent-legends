// The security headers every page of the game is sent with: by server/rooms.mjs for the pages it serves, and by a
// static host through tools/build_site.sh. The Content-Security-Policy lets a page run only the site's own scripts (no
// inline ones, no other sites), load fonts from Google Fonts and open sockets only to the room servers listed in
// `rooms`; no other site may frame the game.
//   rooms: the origins sockets may go to besides the page's own, e.g. ['wss://rooms.example']
//   https: the page is served over https, so every request it makes is upgraded to https too
export function securityHeaders({ rooms = [], https = true } = {}) {
  const csp = [
    "default-src 'self'", "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:", "media-src 'self' data: blob:", `connect-src ${["'self'", ...rooms].join(' ')}`, "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}
