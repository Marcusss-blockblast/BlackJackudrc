import { createBlackjackServer } from "./server/createBlackjackServer.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const defaultNumDecks = Number.parseInt(process.env.BLACKJACK_NUM_DECKS ?? "1", 10);
const maxSeatsPerTable = Number.parseInt(process.env.BLACKJACK_MAX_SEATS ?? "7", 10);
const disconnectGraceMs = Number.parseInt(process.env.BLACKJACK_DISCONNECT_GRACE_MS ?? "30000", 10);
const persistencePath = process.env.BLACKJACK_STATE_FILE;
const accountsPersistencePath = process.env.BLACKJACK_ACCOUNTS_FILE;

const { httpServer } = createBlackjackServer({
  corsOrigin,
  defaultNumDecks,
  maxSeatsPerTable,
  disconnectGraceMs,
  persistencePath,
  accountsPersistencePath,
});

httpServer.listen(port, () => {
  console.log(`Blackjack server listening on port ${port}`);
});