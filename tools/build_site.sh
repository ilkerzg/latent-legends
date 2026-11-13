#!/bin/sh
# Build the static site for Vercel into dist/: only what play.html loads (web/, the engine, the bot, the card data).
# Static hosts have no directory listings, so the asset folders play.js discovers are written to assets/listing.json.
#   sh tools/build_site.sh && (cd dist && vercel deploy --prod)
set -e
cd "$(dirname "$0")/.."
rm -rf dist/web dist/engine dist/sim dist/data
mkdir -p dist/engine dist/sim/bots dist/data
rsync -a --exclude '.*' web/ dist/web/
cp engine/rules.js engine/deck.js engine/rng.js dist/engine/
cp sim/bots/greedy.js dist/sim/bots/
cp data/cards.json dist/data/
# The room server's address stays out of the repo: ROOMS_URL, or the first line of rooms.url at the repo root (git
# ignored), goes into the built pages as <meta name="rooms">. Without one the built game has no online play.
ROOMS_URL="${ROOMS_URL:-$( [ -f rooms.url ] && head -n 1 rooms.url | tr -d '[:space:]' || true )}"
if [ -n "$ROOMS_URL" ]; then
  ROOMS_URL="$ROOMS_URL" node -e '
const fs = require("fs");
const url = process.env.ROOMS_URL;
if (!/^wss?:\/\/[^\s"<>]+$/.test(url)) { console.error("ROOMS_URL must be a ws:// or wss:// address"); process.exit(1); }
const meta = `<meta name="rooms" content="${url}">`;
const page = "dist/web/play.html";
const html = fs.readFileSync(page, "utf8");
if (!html.includes("<meta charset=\"utf-8\">")) { console.error("no charset meta in " + page); process.exit(1); }
fs.writeFileSync(page, html.replace("<meta charset=\"utf-8\">", `<meta charset="utf-8">\n${meta}`));
'
else
  echo "no ROOMS_URL and no rooms.url: the built game has no online play"
fi
node -e '
const fs = require("fs");
const ls = (d) => fs.readdirSync("dist/web/" + d, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).map((e) => e.name).sort();
const out = {};
for (const d of ["assets/", "assets/portraits/", "assets/vfx/", "assets/sfx/"]) out[d] = ls(d);
fs.writeFileSync("dist/web/assets/listing.json", JSON.stringify(out));
'
cat > dist/index.html <<'EOF'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Latent Legends</title>
<meta http-equiv="refresh" content="0; url=web/play.html">
</head>
<body><a href="web/play.html">Play Latent Legends</a></body>
</html>
EOF
# Security headers for every page (server/headers.mjs, the same ones server/rooms.mjs sends): the pages run only the
# site's own scripts, load fonts from Google Fonts and open sockets only to the room server; no other site may frame
# the game.
ROOMS_URL="$ROOMS_URL" node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { securityHeaders } from "./server/headers.mjs";
let rooms = [];
try { if (process.env.ROOMS_URL) rooms = [new URL(process.env.ROOMS_URL).origin.replace(/^http/, "ws")]; } catch {}
const headers = Object.entries(securityHeaders({ rooms })).map(([key, value]) => ({ key, value }));
writeFileSync("dist/vercel.json", JSON.stringify({
  redirects: [{ source: "/", destination: "/web/play.html", permanent: false }],
  headers: [{ source: "/(.*)", headers }],
}, null, 2) + "\n");
'
du -sh dist
