# Latent Legends

A turn-based card and lane strategy game for the browser. Two players, three lanes, five elements. Break two enemy Shrines to win. The full rules are in [RULES.md](RULES.md).

## Run it

Serve the repo root with any static server that lists directories. Then open `web/play.html`:

```
python3 -m http.server 8000
```

Open http://localhost:8000/web/play.html.

For online matches on your own machine, run the room server. It serves the game too, at http://127.0.0.1:8787/web/play.html:

```
node server/rooms.mjs
```

It listens on this machine only. To play from other devices on your network, start it with `HOST=0.0.0.0` and open the game at this machine's address.

## Layout

- `web/`: the game (plain ES modules, no build step), the public balance page (`web/balance.html`) and the notice a phone gets in place of the game (`web/phone.html`): the game is optimized for desktop for now
- `engine/`: the rules engine, decks and seeded RNG, shared by the game, the bots and the servers
- `sim/`: bots, bot-vs-bot balance runs and the data for the balance page
- `data/`: card data (`tools/gen_cards.mjs` builds `data/cards.json`)
- `server/`: a zero-dependency Node room server for online play, its protocol, and the security headers every page is served with
- `cloudflare/`: the same room server as a Cloudflare Worker with Durable Objects
- `tools/build_site.sh`: builds the static site into `dist/`, with its security headers (a Content-Security-Policy that allows only the site's own scripts and the room server) in `dist/vercel.json`. The room server's address is not in the repo. Put it in a `rooms.url` file at the repo root (git ignored) or in `ROOMS_URL`, and the build writes it into the page. Without it the built game has no online play.

## Tests

```
node sim/test_determinism.mjs
node sim/test_hidden.mjs
node server/test_rooms.mjs
```

The Worker has its own end-to-end test. It is described at the top of `cloudflare/test_worker.mjs`.

## License

Everything in this repository (the code, the art, the animations and the sound) is released under the [MIT License](LICENSE).
