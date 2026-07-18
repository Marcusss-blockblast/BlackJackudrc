import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Card, registerBlackjackHandlers, TableRegistry } from "../src/index.js";
import { AccountStore } from "../src/services/AccountStore.js";

function createIo() {
  const roomEvents = [];
  const sockets = new Map();
  let connectionHandler = null;

  return {
    roomEvents,
    sockets: { sockets },
    on(eventName, handler) {
      if (eventName === "connection") {
        connectionHandler = handler;
      }
    },
    connectSocket(socket) {
      sockets.set(socket.id, socket);
      connectionHandler(socket);
    },
    to(room) {
      return {
        emit(eventName, payload) {
          roomEvents.push({ room, eventName, payload });
        },
      };
    },
  };
}

function createSocket(id) {
  const handlers = new Map();

  return {
    id,
    handlers,
    emitted: [],
    joinedRooms: new Set(),
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    emit(eventName, payload) {
      this.emitted.push({ eventName, payload });
    },
    join(room) {
      this.joinedRooms.add(room);
    },
    leave(room) {
      this.joinedRooms.delete(room);
    },
  };
}

function getLastSocketEvent(socket, eventName) {
  return [...socket.emitted].reverse().find((event) => event.eventName === eventName) ?? null;
}

function joinTable(socket, payload) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:join_table")(payload, resolve);
  });
}

function placeBet(socket, amount) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:place_bet")({ amount }, resolve);
  });
}

function startRound(socket) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:start_round")({}, resolve);
  });
}

function doubleDown(socket) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:double_down")({}, resolve);
  });
}

function takeInsurance(socket) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:take_insurance")({}, resolve);
  });
}

function declineInsurance(socket) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:decline_insurance")({}, resolve);
  });
}

function splitHand(socket) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:split")({}, resolve);
  });
}

function stand(socket) {
  return new Promise((resolve) => {
    socket.handlers.get("blackjack:stand")({}, resolve);
  });
}

test("disconnect removes the seat but the player can join again without logging in", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 0 });

  const firstSocket = createSocket("s1");
  const secondSeatSocket = createSocket("s2-seat");
  io.connectSocket(firstSocket);
  io.connectSocket(secondSeatSocket);

  const joinResponse = await joinTable(firstSocket, {
    tableId: "practice",
    playerId: "p1",
    playerName: "Alice",
  });
  await joinTable(secondSeatSocket, {
    tableId: "practice",
    playerId: "p2",
    playerName: "Bob",
  });

  assert.equal(joinResponse.ok, true);
  firstSocket.handlers.get("disconnect")();

  const afterDisconnect = registry.serializeTable("practice");
  assert.equal(afterDisconnect.players.length, 1);

  const secondSocket = createSocket("s2");
  io.connectSocket(secondSocket);

  const reconnectResponse = await joinTable(secondSocket, {
    tableId: "practice",
    playerId: "p1",
    playerName: "Alice",
  });

  assert.equal(reconnectResponse.ok, true);
  assert.equal(reconnectResponse.state.players.find((player) => player.id === "p1")?.connectionState, "connected");
  assert.equal(registry.serializeTable("practice").players.length, 2);
});

test("disconnect timeout removes abandoned seats", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const socket = createSocket("timeout-socket");
  io.connectSocket(socket);

  const joinResponse = await joinTable(socket, {
    tableId: "timeout-table",
    playerId: "p2",
    playerName: "Bob",
  });

  assert.equal(joinResponse.ok, true);
  socket.handlers.get("disconnect")();

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(registry.serializeTable("timeout-table"), null);
  assert.equal(io.roomEvents.at(-1)?.eventName, "blackjack:table_closed");
});

test("live broadcasts are viewer-specific per socket", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("alice-socket");
  const bobSocket = createSocket("bob-socket");
  io.connectSocket(aliceSocket);
  io.connectSocket(bobSocket);

  await joinTable(aliceSocket, {
    tableId: "practice",
    playerId: "alice",
    playerName: "Alice",
  });
  await joinTable(bobSocket, {
    tableId: "practice",
    playerId: "bob",
    playerName: "Bob",
  });

  await placeBet(aliceSocket, 10);

  const aliceState = getLastSocketEvent(aliceSocket, "blackjack:state")?.payload;
  const bobState = getLastSocketEvent(bobSocket, "blackjack:state")?.payload;

  assert.equal(aliceState.players.find((player) => player.id === "alice")?.isViewer, true);
  assert.equal(aliceState.players.find((player) => player.id === "bob")?.isViewer, false);
  assert.equal(bobState.players.find((player) => player.id === "alice")?.isViewer, false);
  assert.equal(bobState.players.find((player) => player.id === "bob")?.isViewer, true);
});

test("single seated player auto-starts the round immediately after placing a bet", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("auto-start-alice");
  io.connectSocket(aliceSocket);

  await joinTable(aliceSocket, {
    tableId: "auto-start-table",
    playerId: "alice",
    playerName: "Alice",
  });

  const placeBetResponse = await placeBet(aliceSocket, 10);
  assert.equal(placeBetResponse.ok, true);
  assert.notEqual(placeBetResponse.state.phase, "waiting_for_bets");
  assert.equal(["player_turns", "insurance", "round_complete"].includes(placeBetResponse.state.phase), true);
});

test("placing a pending bet again replaces it without losing extra balance", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("replace-bet-alice");
  const bobSocket = createSocket("replace-bet-bob");
  io.connectSocket(aliceSocket);
  io.connectSocket(bobSocket);

  await joinTable(aliceSocket, {
    tableId: "replace-bet-table",
    playerId: "alice",
    playerName: "Alice",
  });
  await joinTable(bobSocket, {
    tableId: "replace-bet-table",
    playerId: "bob",
    playerName: "Bob",
  });

  const firstBetResponse = await placeBet(aliceSocket, 10);
  assert.equal(firstBetResponse.ok, true);
  let aliceState = firstBetResponse.state.players.find((player) => player.id === "alice");
  assert.equal(aliceState.currentBet, 10);
  assert.equal(aliceState.balance, 990);

  const secondBetResponse = await placeBet(aliceSocket, 15);
  assert.equal(secondBetResponse.ok, true);
  aliceState = secondBetResponse.state.players.find((player) => player.id === "alice");
  assert.equal(aliceState.currentBet, 15);
  assert.equal(aliceState.balance, 985);
});

test("a disconnected reserved seat does not block auto-start for the remaining live players", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("disconnect-auto-alice");
  const bobSocket = createSocket("disconnect-auto-bob");
  io.connectSocket(aliceSocket);
  io.connectSocket(bobSocket);

  await joinTable(aliceSocket, {
    tableId: "disconnect-auto-table",
    playerId: "alice",
    playerName: "Alice",
  });
  await joinTable(bobSocket, {
    tableId: "disconnect-auto-table",
    playerId: "bob",
    playerName: "Bob",
  });

  await placeBet(aliceSocket, 10);
  bobSocket.handlers.get("disconnect")();

  const startResponse = await placeBet(aliceSocket, 10);
  assert.equal(startResponse.ok, true);
  assert.notEqual(startResponse.state.phase, "waiting_for_bets");
});

test("double down doubles the bet, draws one card, and ends the turn", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("double-alice");
  const bobSocket = createSocket("double-bob");
  io.connectSocket(aliceSocket);
  io.connectSocket(bobSocket);

  await joinTable(aliceSocket, {
    tableId: "double-table",
    playerId: "alice",
    playerName: "Alice",
  });
  await joinTable(bobSocket, {
    tableId: "double-table",
    playerId: "bob",
    playerName: "Bob",
  });

  await placeBet(aliceSocket, 10);
  const table = registry.getTable("double-table");
  table.deck.cards.splice(
    -6,
    6,
    new Card("9", "clubs"),
    new Card("8", "diamonds"),
    new Card("6", "spades"),
    new Card("7", "hearts"),
    new Card("5", "clubs"),
    new Card("4", "hearts"),
  );

  const startResponse = await placeBet(bobSocket, 10);
  assert.equal(startResponse.ok, true);

  const currentPlayer = startResponse.state.currentPlayerId;
  const actingSocket = currentPlayer === "alice" ? aliceSocket : bobSocket;
  const doubleResponse = await doubleDown(actingSocket);

  assert.equal(doubleResponse.ok, true);
  const actingPlayer = doubleResponse.state.players.find((player) => player.id === currentPlayer);
  assert.equal(actingPlayer.currentBet === 0 || actingPlayer.currentBet === 20, true);
  assert.equal(actingPlayer.hand.cards.length, 3);
  assert.notEqual(doubleResponse.state.currentPlayerId, currentPlayer);
});

test("insurance pays when dealer shows an ace and has blackjack", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("insurance-alice");
  io.connectSocket(aliceSocket);

  await joinTable(aliceSocket, {
    tableId: "insurance-table",
    playerId: "alice",
    playerName: "Alice",
  });

  const table = registry.getTable("insurance-table");
  table.deck.cards.splice(
    -4,
    4,
    new Card("K", "spades"),
    new Card("7", "clubs"),
    new Card("A", "hearts"),
    new Card("9", "diamonds"),
  );

  const startResponse = await placeBet(aliceSocket, 10);
  assert.equal(startResponse.ok, true);
  assert.equal(startResponse.state.phase, "insurance");
  assert.equal(startResponse.state.currentPlayerId, "alice");

  const insuranceResponse = await takeInsurance(aliceSocket);
  assert.equal(insuranceResponse.ok, true);
  assert.equal(insuranceResponse.state.phase, "round_complete");

  const aliceState = insuranceResponse.state.players.find((player) => player.id === "alice");
  assert.equal(aliceState.balance, 1000);
  assert.equal(aliceState.hands[0].insuranceStatus, "won");
  assert.equal(aliceState.hands[0].insuranceBet, 5);
});

test("declining insurance returns play to normal turns when dealer does not have blackjack", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("decline-insurance-alice");
  io.connectSocket(aliceSocket);

  await joinTable(aliceSocket, {
    tableId: "decline-insurance-table",
    playerId: "alice",
    playerName: "Alice",
  });

  const table = registry.getTable("decline-insurance-table");
  table.deck.cards.splice(
    -4,
    4,
    new Card("9", "spades"),
    new Card("7", "clubs"),
    new Card("A", "hearts"),
    new Card("9", "diamonds"),
  );

  const startResponse = await placeBet(aliceSocket, 10);
  assert.equal(startResponse.ok, true);
  assert.equal(startResponse.state.phase, "insurance");

  const declineResponse = await declineInsurance(aliceSocket);
  assert.equal(declineResponse.ok, true);
  assert.equal(declineResponse.state.phase, "player_turns");
  assert.equal(declineResponse.state.currentPlayerId, "alice");

  const aliceState = declineResponse.state.players.find((player) => player.id === "alice");
  assert.equal(aliceState.balance, 990);
  assert.equal(aliceState.hands[0].insuranceStatus, "declined");
});

test("split creates two playable hands and advances through them before the next seat", async () => {
  const registry = new TableRegistry();
  const io = createIo();
  registerBlackjackHandlers({ io, registry, disconnectGraceMs: 25 });

  const aliceSocket = createSocket("split-alice");
  const bobSocket = createSocket("split-bob");
  io.connectSocket(aliceSocket);
  io.connectSocket(bobSocket);

  await joinTable(aliceSocket, {
    tableId: "split-table",
    playerId: "alice",
    playerName: "Alice",
  });
  await joinTable(bobSocket, {
    tableId: "split-table",
    playerId: "bob",
    playerName: "Bob",
  });

  await placeBet(aliceSocket, 10);
  const table = registry.getTable("split-table");
  table.deck.cards.splice(
    -6,
    6,
    new Card("9", "diamonds"),
    new Card("6", "spades"),
    new Card("8", "clubs"),
    new Card("7", "hearts"),
    new Card("5", "clubs"),
    new Card("8", "hearts"),
  );

  const startResponse = await placeBet(bobSocket, 10);
  assert.equal(startResponse.ok, true);

  const currentPlayerId = startResponse.state.currentPlayerId;
  const actingSocket = currentPlayerId === "alice" ? aliceSocket : bobSocket;

  const splitResponse = await splitHand(actingSocket);
  assert.equal(splitResponse.ok, true);

  const splitPlayer = splitResponse.state.players.find((player) => player.id === currentPlayerId);
  assert.equal(splitPlayer.handCount, 2);
  assert.equal(splitPlayer.hands.length, 2);
  assert.equal(splitPlayer.hands[0].hand.cards.length, 2);
  assert.equal(splitPlayer.hands[1].hand.cards.length, 2);
  assert.equal(splitResponse.state.currentPlayerId, currentPlayerId);
  assert.equal(splitResponse.state.currentHandIndex, 0);

  const firstStandResponse = await stand(actingSocket);
  assert.equal(firstStandResponse.ok, true);
  assert.equal(firstStandResponse.state.currentPlayerId, currentPlayerId);
  assert.equal(firstStandResponse.state.currentHandIndex, 1);
});

test("registry persists tables and restores them from disk", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blackjack-registry-"));
  const persistencePath = path.join(tempDir, "tables.json");

  try {
    const registry = new TableRegistry({ persistencePath });
    registry.ensurePlayerSeat("practice", { id: "p1", name: "Alice", balance: 100 });
    registry.ensurePlayerSeat("practice", { id: "p2", name: "Bob", balance: 100 });

    const table = registry.getTable("practice");
    table.placeBet("p1", 10);
    table.placeBet("p2", 15);
    table.startRound();

    const restoredRegistry = new TableRegistry({ persistencePath });
    const restoredTable = restoredRegistry.getTable("practice");

    assert.ok(restoredTable);
    assert.equal(restoredTable.players.length, 2);
    assert.equal(restoredTable.phase, table.phase);
    assert.equal(restoredTable.stateVersion, table.stateVersion);
    assert.equal(restoredTable.dealerHand.cards.length, table.dealerHand.cards.length);
    assert.equal(restoredTable.players[0].hand.cards.length, table.players[0].hand.cards.length);
    assert.equal(restoredTable.deck.cards.length, table.deck.cards.length);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("account store seeds from one file and persists to another", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blackjack-accounts-"));
  const seedPath = path.join(tempDir, "seed-accounts.json");
  const persistencePath = path.join(tempDir, "live-accounts.json");

  try {
    fs.writeFileSync(seedPath, JSON.stringify({
      savedAt: new Date().toISOString(),
      accounts: [
        {
          username: "seeduser",
          displayName: "Seed User",
          passwordHash: "salt:hash",
          balance: 250,
          createdAt: new Date().toISOString(),
        },
      ],
    }, null, 2));

    const store = new AccountStore({ persistencePath, seedPath, startingBalance: 1000 });
    assert.equal(store.getAccount("seeduser")?.balance, 250);
    assert.equal(fs.existsSync(persistencePath), true);

    const created = store.register("newuser", "Test1234!");
    assert.equal(created.balance, 1000);
    assert.equal(created.language, null);

    const updatedLanguage = store.setLanguage("newuser", "cs");
    assert.equal(updatedLanguage.language, "cs");

    store.updateBalance("seeduser", 875);
    const restoredStore = new AccountStore({ persistencePath, seedPath, startingBalance: 1000 });
    assert.equal(restoredStore.getAccount("seeduser")?.balance, 875);
    assert.equal(restoredStore.getAccount("newuser")?.balance, 1000);
    assert.equal(restoredStore.getAccount("newuser")?.language, "cs");
    assert.equal(restoredStore.getAccount("seeduser")?.language, null);
    assert.equal(JSON.parse(fs.readFileSync(persistencePath, "utf8")).accounts[0].balance, 875);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("table registry seeds from one file and persists to another", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blackjack-tables-"));
  const seedPath = path.join(tempDir, "seed-tables.json");
  const persistencePath = path.join(tempDir, "live-tables.json");

  try {
    const seedTable = new TableRegistry({ persistencePath: seedPath });
    seedTable.ensurePlayerSeat("seed-table", { id: "p1", name: "Alice", balance: 1000 });
    seedTable.getTable("seed-table").placeBet("p1", 10);
    seedTable.saveToDisk();

    const registry = new TableRegistry({ persistencePath, seedPath });
    assert.equal(registry.getTable("seed-table")?.players.length, 1);
    assert.equal(fs.existsSync(persistencePath), true);

    registry.ensurePlayerSeat("seed-table", { id: "p2", name: "Bob", balance: 1000 });
    registry.saveToDisk();

    const restoredRegistry = new TableRegistry({ persistencePath, seedPath });
    assert.equal(restoredRegistry.getTable("seed-table")?.players.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(persistencePath, "utf8")).tables[0].players.length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});