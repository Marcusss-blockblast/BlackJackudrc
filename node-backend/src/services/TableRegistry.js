import fs from "node:fs";
import path from "node:path";
import { BlackjackTable } from "../game/BlackjackTable.js";

export class TableRegistry {
  constructor({
    defaultNumDecks = 1,
    maxSeatsPerTable = 7,
    persistencePath = null,
  } = {}) {
    this.defaultNumDecks = defaultNumDecks;
    this.maxSeatsPerTable = maxSeatsPerTable;
    this.persistencePath = persistencePath;
    this.tables = new Map();

    this.loadFromDisk();
  }

  getOrCreateTable(tableId) {
    if (!this.tables.has(tableId)) {
      this.tables.set(tableId, this.createTable(tableId));
    }

    return this.tables.get(tableId);
  }

  createTable(tableId) {
    return new BlackjackTable({
      tableId,
      numDecks: this.defaultNumDecks,
      onChange: () => this.saveToDisk(),
    });
  }

  hydrateTable(snapshot) {
    return BlackjackTable.fromSnapshot(snapshot, {
      onChange: () => this.saveToDisk(),
    });
  }

  getTable(tableId) {
    return this.tables.get(tableId) ?? null;
  }

  ensurePlayerSeat(tableId, playerConfig) {
    const table = this.getOrCreateTable(tableId);
    const existingPlayer = table.players.find((player) => player.id === playerConfig.id);

    if (existingPlayer) {
      return { table, player: existingPlayer, created: false };
    }

    if (table.players.length >= this.maxSeatsPerTable) {
      throw new Error(`Table ${tableId} is full.`);
    }

    const player = table.addPlayer(playerConfig);
    return { table, player, created: true };
  }

  removePlayer(tableId, playerId) {
    const table = this.getTable(tableId);
    if (!table) {
      return null;
    }

    table.removePlayer(playerId);

    if (table.players.length === 0) {
      this.tables.delete(tableId);
      this.saveToDisk();
      return null;
    }

    return table;
  }

  listTables() {
    return [...this.tables.values()].map((table) => ({
      tableId: table.tableId,
      phase: table.phase,
      stateVersion: table.stateVersion,
      seatsTaken: table.players.length,
      currentPlayerId: table.getCurrentPlayer()?.id ?? null,
    }));
  }

  serializeTable(tableId, viewerPlayerId = null) {
    const table = this.getTable(tableId);
    if (!table) {
      return null;
    }

    return table.serializeState({ viewerPlayerId });
  }

  loadFromDisk() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.persistencePath, "utf8");
      const parsed = JSON.parse(raw);
      const tableSnapshots = Array.isArray(parsed.tables) ? parsed.tables : [];

      for (const snapshot of tableSnapshots) {
        if (!snapshot?.tableId) {
          continue;
        }

        this.tables.set(snapshot.tableId, this.hydrateTable(snapshot));
      }
    } catch (error) {
      console.error(`Failed to load blackjack state from ${this.persistencePath}:`, error);
    }
  }

  saveToDisk() {
    if (!this.persistencePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      const snapshot = {
        savedAt: new Date().toISOString(),
        tables: [...this.tables.values()].map((table) => table.toSnapshot()),
      };
      const tempPath = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
      fs.renameSync(tempPath, this.persistencePath);
    } catch (error) {
      console.error(`Failed to save blackjack state to ${this.persistencePath}:`, error);
    }
  }
}