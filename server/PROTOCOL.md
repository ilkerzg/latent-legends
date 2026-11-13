# Latent Legends room protocol

One WebSocket at `/ws` on `server/rooms.mjs`. Every message is one JSON text frame with a `type` field.
The server runs the real engine for every room. Clients send actions and apply only the actions the server
broadcasts, in order, so every client stays in sync with the server by replaying the same deterministic engine.
Each client replays it from what its seat may see (`engine/hidden.js`): the order of both decks and the opponent's
hand never leave the server. A client's copy holds `HIDDEN` (`'?'`) for every card it may not see, and each action
brings the cards it draws.

Run it: `node server/rooms.mjs` (env `PORT`, default 8787; `HOST`, default 127.0.0.1; `GRACE_MS`, default 60000;
`IDLE_MS`, default 600000). The same process serves `web/`, `engine/`, `sim/` and `data/`, so the game is at
`http://127.0.0.1:8787/web/play.html`. It listens on this machine only; `HOST=0.0.0.0` lets other devices on the network
open the game at this machine's address. Every answer carries the security headers of `server/headers.mjs`.
A plain GET on `/ws` (or `/healthz`) returns `{"server":"latent-legends-rooms","ok":true,...}`.

## The Cloudflare server

The live game uses `cloudflare/worker.js`: the same messages and rules, one Durable Object per room. There a socket
belongs to one room, chosen by its address when it opens: `/ws?new=1` for a room you are about to `create`, and
`/ws?room=CODE` to `join` or `resume`. `create` on any other socket answers an error; a malformed or unknown code
answers `unknown room`. Pages from other sites get 403 (the allowed origins are `ORIGINS` in `cloudflare/wrangler.toml`,
plus localhost). `web/net.js` opens the right address itself, and rooms.mjs ignores the query, so net.js works with both.
Rooms are kept in storage there, so a deploy or a restart only drops the sockets: clients reconnect and `resume`.
A daily budget caps the bill: each socket and each match start (rematches too) counts, per UTC day, overall
(`DAILY_SOCKETS`, `DAILY_MATCHES`) and per address (`SOCKETS_PER_IP`, `MATCHES_PER_IP`; an IPv6 /64 counts as one
address, and a match counts for both players' addresses). One address may also open only `SOCKETS_PER_IP_MIN` sockets
a minute, and a socket may send only `MSGS_PER_SOCKET` messages, so the day's messages have a ceiling too. Addresses are
kept only as a hash salted per day. Past a cap the answer is `error: busy`, sent over a socket that then closes (net.js
stops reconnecting on it); a match that cannot start leaves both players in the room. A match charged to the budget
that does not start after all (a player left while the budget answered) is given back.
A few addresses can not use the day up for everyone: no address may hold more than a twentieth of the matches left
today (never fewer than 10), and a match that ends within 45 s of its start goes back to the day's budget and marks the
address that ended it (the one that left; both players when the match itself ended that fast). An address with
`QUICK_PER_IP` marks (6) starts no more matches that day.
A socket that takes no seat (no `create`, `join` or `resume`) within `JOIN_MS` (30 s) is closed with code 4002. Binary
frames close the socket with 1003. A socket may send 100 of the messages that change a room (`create`, `join`, `resume`,
`rematch`, `leave`); the next one closes it with 1008 (net.js then opens a new socket and resumes).
Turn clock (Cloudflare only): each turn has `TURN_MS` (75 s: about 60 s to decide plus the time the last turn takes to
play out). `start` carries `left` (ms left for the active player) and `turnMs`; every `action` carries `left` again.
When the clock runs out the room plays the rest of that turn itself (the main phase ends, every unit attacks): those
`action` messages carry `auto: true`. A player who runs out three turns in a row loses: `over` with reason `timeout`.
Run it locally with `npm run dev` in `cloudflare/` (port 8787, where the game looks on localhost); test it with
`npx wrangler dev --port 8787 --var GRACE_MS:3000 --var JOIN_MS:2000` and `JOIN_MS=2000 node test_worker.mjs`.

## Client to server

| type | fields | what it does |
|---|---|---|
| `hello` | `name` | Sets your display name for later `create`/`join`. Optional. |
| `create` | `deck`, `name` | Makes a room and seats you in it. `deck` is 20 card ids, checked with `validateDeck`. |
| `join` | `code`, `deck`, `name` | Joins a room. The code is case insensitive. The match starts when the second player joins. |
| `action` | `a`, `n` | Plays action `a`. `n` is the number of actions you have applied so far. |
| `resume` | `code`, `token` | Takes your seat back after a reload or a dropped link. |
| `rematch` | `deck` (optional) | After a match ends. When both players ask, a new match starts. |
| `leave` | | Leaves the room. Leaving a running match loses it. |
| `ping` | `t` (optional) | The server answers `pong` with the same `t`. |

Unknown types are ignored.

## Server to client

| type | fields | when |
|---|---|---|
| `room` | `code`, `seat`, `players`, `token`, `match` | You entered a room, or the room changed (join, leave, online status, rematch request). `token` is yours alone, keep it for `resume`. `seat` is null until the first match starts. `players` is `[{ name, seat, online, rematch }]`. |
| `start` | `deal`, `lanes`, `decks`, `seat`, `cfg`, `names`, `actions`, `match` | A match starts, or you resumed one. Build it with `newGame(db, deal, 0, { ...cfg, log: true, dealt: true, lanes })`: `deal[i]` is seat `i`'s deck in the order it is dealt from (top card last), with every card you may not see as `'?'` (you see your own opening hand). Then for each `{ a, r }` in `actions` (empty for a new match): `reveal(s, r)`, `apply(s, a)`. `decks[i]` is seat `i`'s deck list, sorted, for loading its art. `names[i]` belongs to seat `i`. `match` counts matches in this room. |
| `action` | `a`, `n`, `seat`, `r`, `left`, `auto` | Action number `n` (from 0) was accepted: `reveal(s, r)`, then `apply(s, a)`. `r[i]` lists the cards seat `i` draws in this action, in draw order, `'?'` for the ones you may not see (a card burned from a full hand shows to both). Your own actions come back this way too. Cloudflare only: `left` is the ms left on the turn clock, `auto: true` marks an action the room played because the clock ran out. |
| `reject` | `reason`, `n` | Your action was refused: `not your turn`, `illegal action`, `stale` (your `n` is old; `n` is the server's count), `no match`, `game over`. Nothing changed. |
| `opponent_left` | `graceMs` | The other player dropped. During a match they have `graceMs` to come back, then you win by forfeit. `graceMs` is 0 when no match is running (or they left for good). |
| `opponent_back` | | The other player resumed. |
| `over` | `winner`, `reason` | The match ended. `winner` is a seat (0 or 1), `'draw'`, or null. `reason` is the engine's (`shrines`, `turnLimit`) or `forfeit` (grace ran out), `left` (opponent left), `timeout` (out of time three turns in a row, Cloudflare only) or `error` (engine fault). |
| `error` | `reason` | A room request failed: `bad deck: ...`, `unknown room`, `room full`, `not in a room`, `no finished match`, `no opponent`, `room expired`, `server full`, `rate limit`, `bad json`, `bad message`. |
| `pong` | `t` | Answer to `ping`. |

## Rules the server enforces

- Seats: which player gets seat 0 is random for the first match. Seat 0 moves first. A rematch swaps seats and deals again.
- Actions: accepted only from the seat in `s.active` (combat choices belong to the active player too), only when `n` equals the number of actions so far, and only when `a` deep equals one of `legalActions(s)`. Extra fields make it illegal, and so does anything that is not a small flat object (`server/guard.mjs` actionShape), before it is compared.
- Hidden information: the server shuffles both decks with its cryptographic random generator and keeps the order; each seat gets only its own cards as they are drawn (see `start` and `action`). Nothing a seat is sent lets it work out a card it has not been shown.
- Rooms: 5 character codes from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Two players per room. A room with no traffic for 10 minutes is closed (members get `error: room expired`).
- Disconnects: a dropped player keeps the seat. During a match the opponent gets `opponent_left` and the dropped player has 60 s to `resume`, or loses by forfeit. A `resume` from a second tab takes the seat; the old socket is closed with code 4000. A `resume` with a wrong code or a wrong token answers `unknown room` either way, so it does not tell whether a room is open.
- Leaving: when a player leaves, the other keeps the room and its code, and the match that was played there is gone: a `resume` then brings only `room`, and a new opponent can `join`.
- Limits: 16 KiB per message (larger closes the socket with 1009), a token bucket per connection (burst 120, 60 per second; extra messages are dropped with `error: rate limit`, a flood closes with 1008). The server pings every 20 s and drops sockets that stay silent. A message that makes a handler throw closes that socket with 1011; the room and the server go on.
- Names: control, bidi and zero width characters and angle brackets are removed, so one name can not pass for another.
- rooms.mjs only: every WebSocket frame counts (burst 400, 200 per second), a message has at most 64 fragments, and a client that stops reading is cut off. An address may hold `perIp` sockets (32), create `roomsPerMin` rooms a minute (10) and miss `failedJoins` joins or resumes in 10 minutes (20; past that `error: rate limit` and the socket closes). A socket whose other side closes without a close frame gives its place back at once. A room nobody is connected to and no match runs in closes after `waitMs` (60 s). Sockets are accepted from the server's own pages, pages on this machine or the local network, and `origins`; other sites get 403.

## Known gaps

- Deck lists are public: both clients get both lists (sorted, without their order) so the opponent's art loads before the match. Hands and the deck order are not.
- rooms.mjs has no turn clock: there a player who stays connected and never acts stalls the match. (The Cloudflare rooms have one.)
- No accounts. The token in `sessionStorage` is the only proof of a seat. net.js keeps it with the address of the room server that gave it out and sends it nowhere else.
- rooms.mjs keeps rooms in memory: restarting it ends every match. (The Cloudflare rooms are stored.)
