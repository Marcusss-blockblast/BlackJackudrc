import { createBlackjackServer } from "./server/createBlackjackServer.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const renderDataDir = "/opt/render/project/src/node-backend/data";
const localDataDir = path.resolve(__dirname, "../data");
const defaultStateFile = process.env.RENDER
  ? path.join(renderDataDir, "table-state.json")
  : path.join(localDataDir, "table-state.json");
const defaultAccountsFile = process.env.RENDER
  ? path.join(renderDataDir, "accounts.json")
  : path.join(localDataDir, "accounts.json");

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const defaultNumDecks = Number.parseInt(process.env.BLACKJACK_NUM_DECKS ?? "1", 10);
const maxSeatsPerTable = Number.parseInt(process.env.BLACKJACK_MAX_SEATS ?? "7", 10);
const disconnectGraceMs = Number.parseInt(process.env.BLACKJACK_DISCONNECT_GRACE_MS ?? "30000", 10);
const persistencePath = process.env.BLACKJACK_STATE_FILE ?? defaultStateFile;
const accountsPersistencePath = process.env.BLACKJACK_ACCOUNTS_FILE ?? defaultAccountsFile;
const adminPassword = process.env.BLACKJACK_ADMIN_PASSWORD ?? "DEVU";

const { httpServer } = createBlackjackServer({
  corsOrigin,
  defaultNumDecks,
  maxSeatsPerTable,
  disconnectGraceMs,
  persistencePath,
  accountsPersistencePath,
  adminPassword,
});

httpServer.listen(port, () => {
  console.log("Runtime config:", {
    port,
    corsOrigin,
    persistencePath,
    accountsPersistencePath,
    hasCustomAdminPassword: Boolean(process.env.BLACKJACK_ADMIN_PASSWORD),
    renderEnvironment: Boolean(process.env.RENDER),
  });
  console.log(`Blackjack server listening on port ${port}`);
});