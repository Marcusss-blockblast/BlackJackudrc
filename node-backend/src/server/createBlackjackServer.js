import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
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
const dataDir = path.resolve(__dirname, "../../data");
const seedTableStatePath = path.resolve(dataDir, "table-state.json");
const seedAccountsPath = path.resolve(dataDir, "accounts.json");
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function diagnoseStoragePath(filePath) {
  if (!filePath) {
    return {
      filePath: null,
      directoryPath: null,
      fileExists: false,
      directoryExists: false,
      fileWritable: false,
      directoryWritable: false,
    };
  }

  const directoryPath = path.dirname(filePath);
  const fileExists = fs.existsSync(filePath);
  const directoryExists = fs.existsSync(directoryPath);

  let fileWritable = false;
  let directoryWritable = false;

  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
    directoryWritable = true;
  } catch {
    directoryWritable = false;
  }

  if (fileExists) {
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
      fileWritable = true;
    } catch {
      fileWritable = false;
    }
  }

  return {
    filePath,
    directoryPath,
    fileExists,
    directoryExists,
    fileWritable,
    directoryWritable,
  };
}

export function createBlackjackServer({
  corsOrigin = "*",
  defaultNumDecks = 1,
  maxSeatsPerTable = 7,
  disconnectGraceMs = 30000,
  persistencePath = seedTableStatePath,
  accountsPersistencePath = seedAccountsPath,
  adminPassword = process.env.BLACKJACK_ADMIN_PASSWORD || "DEVU",
} = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
    },
  });

  const registry = new TableRegistry({
    defaultNumDecks,
    maxSeatsPerTable,
    persistencePath,
    seedPath: seedTableStatePath,
  });
  const accounts = new AccountStore({
    persistencePath: accountsPersistencePath,
    seedPath: seedAccountsPath,
  });
  const sessions = new SessionManager();

  const adminTokens = new Map();

  const createAdminToken = () => {
    const token = crypto.randomBytes(24).toString("hex");
    adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
    return token;
  };

  const isValidAdminToken = (token) => {
    if (!token) {
      return false;
    }

    const expiresAt = adminTokens.get(token);
    if (!expiresAt) {
      return false;
    }

    if (expiresAt < Date.now()) {
      adminTokens.delete(token);
      return false;
    }

    return true;
  };

  const requireAdmin = (request, response, next) => {
    const token = request.headers["x-admin-token"] || request.query.token;
    if (!isValidAdminToken(token)) {
      response.status(401).json({ error: "Admin session expired or invalid. Please log in again." });
      return;
    }

    next();
  };

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/health", (_request, response) => {
    const tableStorage = diagnoseStoragePath(persistencePath);
    const accountsStorage = diagnoseStoragePath(accountsPersistencePath);
    const storageHealthy = tableStorage.directoryWritable && accountsStorage.directoryWritable;

    response.json({
      ok: true,
      storageHealthy,
      storage: {
        tableState: tableStorage,
        accounts: accountsStorage,
      },
    });
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

  app.post("/api/admin/login", (request, response) => {
    const { password } = request.body ?? {};
    if (String(password ?? "") !== String(adminPassword)) {
      response.status(401).json({ error: "Incorrect admin password." });
      return;
    }

    response.json({ token: createAdminToken() });
  });

  app.post("/api/admin/logout", requireAdmin, (request, response) => {
    const token = request.headers["x-admin-token"] || request.query.token;
    adminTokens.delete(token);
    response.json({ ok: true });
  });

  app.get("/api/admin/overview", requireAdmin, (_request, response) => {
    response.json({
      accounts: accounts.listAccounts(),
      tables: registry.listTables().map((summary) => blackjackAdmin.getFullTableState(summary.tableId)),
    });
  });

  app.patch("/api/admin/accounts/:username/balance", requireAdmin, (request, response) => {
    try {
      const { username } = request.params;
      const { balance } = request.body ?? {};
      const parsedBalance = Number.parseInt(balance, 10);
      if (!Number.isFinite(parsedBalance) || parsedBalance < 0) {
        throw new Error("Balance must be a non-negative number.");
      }

      if (!accounts.getAccount(username)) {
        throw new Error("Account not found.");
      }

      accounts.updateBalance(username, parsedBalance);
      blackjackAdmin.syncPlayerBalance(username, parsedBalance);
      response.json({ ok: true, account: accounts.getAccount(username) });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/admin/accounts/adjust-all", requireAdmin, (request, response) => {
    try {
      const { delta } = request.body ?? {};
      const parsedDelta = Number.parseInt(delta, 10);
      if (!Number.isFinite(parsedDelta) || parsedDelta === 0) {
        throw new Error("Enter a non-zero whole number amount to apply.");
      }

      const updated = accounts.adjustAllBalances(parsedDelta);
      for (const { username, balance } of updated) {
        blackjackAdmin.syncPlayerBalance(username, balance);
      }

      response.json({ ok: true, count: updated.length });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/admin/accounts/:username/password", requireAdmin, (request, response) => {
    try {
      const { username } = request.params;
      const { password } = request.body ?? {};
      accounts.setPassword(username, password);
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/admin/accounts/:username", requireAdmin, (request, response) => {
    try {
      const { username } = request.params;
      blackjackAdmin.kickPlayerEverywhere(username);
      if (!accounts.deleteAccount(username)) {
        throw new Error("Account not found.");
      }

      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("/api/admin/tables", requireAdmin, (_request, response) => {
    response.json({
      tables: registry.listTables().map((summary) => blackjackAdmin.getFullTableState(summary.tableId)),
    });
  });

  app.post("/api/admin/tables/:tableId/kick/:playerId", requireAdmin, (request, response) => {
    try {
      const { tableId, playerId } = request.params;
      blackjackAdmin.kickPlayer(tableId, playerId);
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/admin/tables/:tableId/reset", requireAdmin, (request, response) => {
    try {
      blackjackAdmin.resetTable(request.params.tableId);
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  const blackjackAdmin = registerBlackjackHandlers({ io, registry, disconnectGraceMs, accounts, sessions });

  return {
    app,
    io,
    httpServer,
    registry,
    accounts,
    sessions,
  };
}
