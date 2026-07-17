import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { TableRegistry } from "../services/TableRegistry.js";
import { AccountStore } from "../services/AccountStore.js";
import { SessionManager } from "../services/SessionManager.js";
import { registerBlackjackHandlers } from "../socket/registerBlackjackHandlers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../../public");

export function createBlackjackServer({
  corsOrigin = "*",
  defaultNumDecks = 1,
  maxSeatsPerTable = 7,
  disconnectGraceMs = 30000,
  persistencePath = path.resolve(__dirname, "../../data/table-state.json"),
  accountsPersistencePath = path.resolve(__dirname, "../../data/accounts.json"),
} = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
    },
  });

  const registry = new TableRegistry({ defaultNumDecks, maxSeatsPerTable, persistencePath });
  const accounts = new AccountStore({ persistencePath: accountsPersistencePath });
  const sessions = new SessionManager();

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/auth/register", (request, response) => {
    try {
      const { username, password } = request.body ?? {};
      const account = accounts.register(username, password);
      const token = sessions.createSession(account.username);
      response.json({ token, account });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login", (request, response) => {
    try {
      const { username, password } = request.body ?? {};
      const account = accounts.verifyLogin(username, password);
      const token = sessions.createSession(account.username);
      response.json({ token, account });
    } catch (error) {
      response.status(401).json({ error: error.message });
    }
  });

  app.post("/api/auth/logout", (request, response) => {
    const { token } = request.body ?? {};
    sessions.destroySession(token);
    response.json({ ok: true });
  });

  app.get("/api/auth/session", (request, response) => {
    const token = request.query.token ?? request.headers["x-session-token"];
    const username = sessions.getUsername(token);
    if (!username) {
      response.status(401).json({ error: "Session expired. Please log in again." });
      return;
    }

    response.json({ token, account: accounts.getAccount(username) });
  });

  app.get("/tables", (_request, response) => {
    response.json({ tables: registry.listTables() });
  });

  app.get("/tables/:tableId", (request, response) => {
    const state = registry.serializeTable(request.params.tableId);
    if (!state) {
      response.status(404).json({ error: "Table not found." });
      return;
    }

    response.json(state);
  });

  app.get("/app", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  registerBlackjackHandlers({ io, registry, disconnectGraceMs, accounts, sessions });

  return {
    app,
    io,
    httpServer,
    registry,
    accounts,
    sessions,
  };
}
