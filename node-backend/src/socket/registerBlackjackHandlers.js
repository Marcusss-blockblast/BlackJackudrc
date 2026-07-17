const DEFAULT_BALANCE = 1000;

function emitTableError(socket, error) {
  socket.emit("blackjack:error", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Resolves the identity for a join_table request. When `accounts`/`sessions` are supplied
 * (always true for the real running server) the caller MUST provide a valid session token,
 * and the playerId/playerName/balance are derived from the authenticated account rather than
 * trusted client input. When `accounts`/`sessions` are omitted, the handlers fall back to the
 * legacy trusted-payload contract, which is only used by the internal unit test harness.
 */
function resolveIdentity(payload, { accounts, sessions }) {
  const tableId = String(payload?.tableId ?? "").trim();
  if (!tableId) {
    throw new Error("tableId is required.");
  }

  if (accounts && sessions) {
    const token = String(payload?.token ?? "").trim();
    if (!token) {
      throw new Error("A valid session token is required. Please log in again.");
    }

    const username = sessions.getUsername(token);
    if (!username) {
      throw new Error("Your session has expired. Please log in again.");
    }

    const account = accounts.getAccount(username);
    if (!account) {
      throw new Error("Account not found.");
    }

    return { tableId, playerId: username, playerName: account.displayName, balance: account.balance };
  }

  const playerId = String(payload?.playerId ?? "").trim();
  const playerName = String(payload?.playerName ?? "").trim();

  if (!playerId || !playerName) {
    throw new Error("tableId, playerId, and playerName are required.");
  }

  const balance = parseInt(payload?.balance, 10) || DEFAULT_BALANCE;
  return { tableId, playerId, playerName, balance };
}

export function registerBlackjackHandlers({
  io,
  registry,
  disconnectGraceMs = 30000,
  accounts = null,
  sessions = null,
}) {
  const socketPresence = new Map();
  const playerOwners = new Map();

  const getPresenceKey = (tableId, playerId) => `${tableId}:${playerId}`;

  const decorateState = (state) => {
    if (!state) {
      return null;
    }

    return {
      ...state,
      players: state.players.map((player) => {
        const presenceKey = getPresenceKey(state.tableId, player.id);
        const ownerSocketId = playerOwners.get(presenceKey);

        return {
          ...player,
          isConnected: Boolean(ownerSocketId),
          connectionState: ownerSocketId ? "connected" : "disconnected",
          disconnectGraceExpiresAt: null,
        };
      }),
    };
  };

  const serializeTableState = (tableId, viewerPlayerId = null) => {
    const state = registry.serializeTable(tableId, viewerPlayerId);
    return decorateState(state);
  };

  const broadcastTablesSummary = () => {
    io.emit?.("blackjack:tables_summary", { tables: registry.listTables() });
  };

  const shouldAutoStartTable = (tableId) => {
    const table = registry.getTable(tableId);
    if (!table || !["waiting_for_players", "waiting_for_bets", "round_complete"].includes(table.phase)) {
      return false;
    }

    const activePlayers = table.players.filter((player) => {
      const presenceKey = getPresenceKey(tableId, player.id);
      return playerOwners.has(presenceKey);
    });

    return activePlayers.length > 0 && activePlayers.every((player) => player.currentBet > 0);
  };

  const emitTableState = (tableId) => {
    for (const [socketId, presence] of socketPresence.entries()) {
      if (presence.tableId !== tableId) {
        continue;
      }

      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) {
        continue;
      }

      targetSocket.emit("blackjack:state", serializeTableState(tableId, presence.playerId));
    }

    broadcastTablesSummary();
  };

  const finalizePlayerRemoval = ({ tableId, playerId }) => {
    if (accounts) {
      const outgoingTable = registry.getTable(tableId);
      const outgoingPlayer = outgoingTable?.players.find((player) => player.id === playerId);
      if (outgoingPlayer) {
        accounts.updateBalance(playerId, outgoingPlayer.balance);
      }
    }

    const table = registry.removePlayer(tableId, playerId);
    if (table) {
      emitTableState(tableId);
      return;
    }

    io.to(tableId).emit("blackjack:table_closed", { tableId });
    broadcastTablesSummary();
  };

  io.on("connection", (socket) => {
    const leaveCurrentTable = () => {
      const presence = socketPresence.get(socket.id);
      if (!presence) {
        return;
      }

      const presenceKey = getPresenceKey(presence.tableId, presence.playerId);
      const currentOwnerSocketId = playerOwners.get(presenceKey);

      socket.leave(presence.tableId);
      socketPresence.delete(socket.id);

      if (currentOwnerSocketId !== socket.id) {
        return;
      }

      playerOwners.delete(presenceKey);

      finalizePlayerRemoval(presence);
    };

    const scheduleDisconnectRemoval = () => {
      const presence = socketPresence.get(socket.id);
      if (!presence) {
        return;
      }

      const presenceKey = getPresenceKey(presence.tableId, presence.playerId);
      const currentOwnerSocketId = playerOwners.get(presenceKey);

      socket.leave(presence.tableId);
      socketPresence.delete(socket.id);

      if (currentOwnerSocketId !== socket.id) {
        return;
      }

      playerOwners.delete(presenceKey);

      finalizePlayerRemoval(presence);
    };

    const broadcastTableState = (tableId, viewerPlayerId = null) => {
      const state = serializeTableState(tableId, viewerPlayerId);
      if (state) {
        emitTableState(tableId);
      }
      return state;
    };

    // Socket state stays outside the game engine.
    // The engine only knows about table/player state, which keeps it reusable for HTTP, bots, and tests.
    socket.on("blackjack:join_table", (payload = {}, callback) => {
      try {
        const { tableId, playerId, playerName, balance } = resolveIdentity(payload, { accounts, sessions });
        const presenceKey = getPresenceKey(tableId, playerId);

        if (socketPresence.has(socket.id)) {
          const current = socketPresence.get(socket.id);
          if (current.tableId !== tableId || current.playerId !== playerId) {
            leaveCurrentTable();
          }
        }

        const existingOwnerSocketId = playerOwners.get(presenceKey);
        if (existingOwnerSocketId && existingOwnerSocketId !== socket.id) {
          const existingOwnerSocket = io.sockets.sockets.get(existingOwnerSocketId);
          if (existingOwnerSocket) {
            existingOwnerSocket.emit("blackjack:session_replaced", {
              tableId,
              playerId,
            });
            existingOwnerSocket.leave(tableId);
          }

          socketPresence.delete(existingOwnerSocketId);
        }

        const { table } = registry.ensurePlayerSeat(tableId, {
          id: playerId,
          name: playerName,
          balance,
        });

        socket.join(tableId);
        socketPresence.set(socket.id, { tableId, playerId });
        playerOwners.set(presenceKey, socket.id);

        const state = serializeTableState(tableId, playerId);
        emitTableState(tableId);
        callback?.({ ok: true, state, tableId, playerId });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:leave_table", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Socket is not seated at any table.");
        }

        leaveCurrentTable();
        callback?.({ ok: true });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:get_state", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Socket is not seated at any table.");
        }

        const state = serializeTableState(presence.tableId, presence.playerId);
        callback?.({ ok: true, state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:place_bet", (payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before placing a bet.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        table.placeBet(presence.playerId, Number.parseInt(payload.amount, 10));
        const shouldAutoStart = shouldAutoStartTable(presence.tableId);
        const state = shouldAutoStart
          ? table.startRound()
          : broadcastTableState(presence.tableId, presence.playerId);

        if (shouldAutoStart) {
          emitTableState(presence.tableId);
        }

        callback?.({
          ok: true,
          state: shouldAutoStart ? serializeTableState(presence.tableId, presence.playerId) ?? state : state,
        });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:start_round", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before starting a round.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.startRound();
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:hit", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.hit(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:stand", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.stand(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:split", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.split(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:take_insurance", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.takeInsurance(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:decline_insurance", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.declineInsurance(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:surrender", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.surrender(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("blackjack:double_down", (_payload = {}, callback) => {
      try {
        const presence = socketPresence.get(socket.id);
        if (!presence) {
          throw new Error("Join a table before taking an action.");
        }

        const table = registry.getTable(presence.tableId);
        if (!table) {
          throw new Error("Table no longer exists.");
        }

        const state = table.doubleDown(presence.playerId);
        emitTableState(presence.tableId);
        callback?.({ ok: true, state: serializeTableState(presence.tableId, presence.playerId) ?? state });
      } catch (error) {
        emitTableError(socket, error);
        callback?.({ ok: false, error: error.message });
      }
    });

    socket.on("disconnect", () => {
      scheduleDisconnectRemoval();
    });
  });
}