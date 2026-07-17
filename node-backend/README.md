# Blackjack Node Backend

This folder contains the Node.js backend version of the blackjack game logic, prepared for real-time multiplayer play with Socket.IO.

## File map

- `src/index.js` - public exports for the game engine and server helpers.
- `src/models/Card.js` - card representation and card value logic.
- `src/models/Hand.js` - hand totals, ace handling, alternate totals, blackjack detection.
- `src/game/Deck.js` - multi-deck shoe creation, shuffling, low-card reshuffle behavior.
- `src/game/PlayerSeat.js` - per-player balance, bet state, hand state, settlement, and history.
- `src/game/BlackjackTable.js` - round flow, player turn order, dealer turn, outcome resolution, state snapshots.
- `src/services/TableRegistry.js` - in-memory room registry that stores one table instance per table ID.
- `src/socket/registerBlackjackHandlers.js` - Socket.IO events for joining tables and taking actions.
- `src/server/createBlackjackServer.js` - Express + Socket.IO server factory.
- `src/server.js` - process entrypoint used by `npm start`.
- `public/index.html` - browser test client for manual Socket.IO testing.
- `public/app.js` - browser-side Socket.IO wiring and state rendering.
- `public/styles.css` - styling for the browser test client.
- `scripts/smoke-test.js` - local engine smoke test without sockets.
- `scripts/socket-demo-client.js` - simple Socket.IO client for manually testing join/bet/start/action flow.

## Install and run

After Node.js is installed and available in your terminal:

```bash
cd "c:\Users\Mára\black jack\node-backend"
npm install
npm start
```

The server listens on `http://localhost:3000` by default.

Open `http://localhost:3000/app` to use the browser client.

## One-click verification (Windows)

From the project root (`Blackjack Project`), run:

```powershell
.\verify-node-backend.ps1
```

or double-click:

```bat
verify-node-backend.bat
```

This flow checks Node/npm availability, installs dependencies, runs smoke tests, and runs the test suite.

Optional flags:

- `-SkipSmoke` to skip the smoke test.
- `-SkipTests` to skip the full test suite.

## Production deployment

For Render blueprint deployment and custom domain setup, see:

- `../DEPLOY_RENDER.md`

## Environment variables

Copy `.env.example` to `.env` if you want custom values.

- `PORT` - HTTP/Socket.IO server port.
- `CORS_ORIGIN` - allowed frontend origin.
- `BLACKJACK_NUM_DECKS` - number of decks used by new tables.
- `BLACKJACK_MAX_SEATS` - max players allowed per table.
- `BLACKJACK_DISCONNECT_GRACE_MS` - how long a disconnected player seat is kept reserved before removal.
- `BLACKJACK_STATE_FILE` - optional path for persisted table state; defaults to `data/table-state.json` inside `node-backend`.

## HTTP routes

- `GET /health`
- `GET /tables`
- `GET /tables/:tableId`

## Socket.IO events

Client -> server:

- `blackjack:join_table`
- `blackjack:leave_table`
- `blackjack:get_state`
- `blackjack:place_bet`
- `blackjack:start_round`
- `blackjack:hit`
- `blackjack:stand`
- `blackjack:split`
- `blackjack:double_down`
- `blackjack:take_insurance`
- `blackjack:decline_insurance`
- `blackjack:surrender`

Server -> client:

- `blackjack:state`
- `blackjack:error`
- `blackjack:table_closed`
- `blackjack:session_replaced`

## Reconnect behavior

When a client disconnects unexpectedly, the server keeps that player seat reserved for a short grace period instead of removing it immediately. If the browser reconnects and rejoins with the same `playerId` before the grace window expires, the player resumes the same seat and table state.

The grace window defaults to 30 seconds and can be configured with `BLACKJACK_DISCONNECT_GRACE_MS`.

## Demo client

Start the server first, then run one or more demo clients:

```bash
npm run client:demo -- --player p1 --name Alice --table practice --bet 10 --start
npm run client:demo -- --player p2 --name Bob --table practice --bet 15
```

The first client can use `--start` to begin the round after joining. The demo client will auto-play with a simple rule: hit below 17, otherwise stand.

## Browser client

After the server is running, open:

```bash
http://localhost:3000/app
```

Use the browser page to:

- create an account or sign in (passwords are hashed with scrypt and stored in `data/accounts.json`)
- pick one of the 4 always-open tables from the lobby menu
- place a bet
- start a round
- hit, stand, or surrender when it is your turn
- split matching opening pairs into two separately playable hands
- double down on an opening two-card hand when you have enough balance
- take or decline insurance when the dealer shows an ace
- watch live state updates from other players in the same room, and live seat counts for every table in the lobby, pushed instantly over the socket connection (no polling)

Round results are determined only by the cards and blackjack rules. The backend no longer applies any player-specific win bias during settlement.

Active tables and player seat state are now persisted to disk and restored when the server starts again. Player accounts and balances are persisted separately in `data/accounts.json` (configurable via `BLACKJACK_ACCOUNTS_FILE`).