import { io } from "socket.io-client";

function parseArgs(argv) {
  const options = {
    url: process.env.BLACKJACK_SERVER_URL ?? "http://localhost:3000",
    tableId: "practice-table",
    playerId: `player-${Math.random().toString(36).slice(2, 8)}`,
    playerName: "Demo Player",
    bet: 10,
    balance: 100,
    shouldStart: false,
    autoPlay: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--url" && next) {
      options.url = next;
      index += 1;
      continue;
    }

    if ((token === "--table" || token === "--tableId") && next) {
      options.tableId = next;
      index += 1;
      continue;
    }

    if ((token === "--player" || token === "--playerId") && next) {
      options.playerId = next;
      index += 1;
      continue;
    }

    if ((token === "--name" || token === "--playerName") && next) {
      options.playerName = next;
      index += 1;
      continue;
    }

    if (token === "--bet" && next) {
      options.bet = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === "--balance" && next) {
      options.balance = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (token === "--start") {
      options.shouldStart = true;
      continue;
    }

    if (token === "--no-auto") {
      options.autoPlay = false;
    }
  }

  return options;
}

function emitWithAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(eventName, payload, (response = {}) => {
      if (response.ok) {
        resolve(response);
        return;
      }

      reject(new Error(response.error ?? `Request failed for ${eventName}`));
    });
  });
}

function describeHand(hand) {
  if (!hand?.cards) {
    return "(no hand)";
  }

  return `${hand.cards.map((card) => card.label ?? "??").join(" ")} => ${hand.value}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const socket = io(options.url, {
    transports: ["websocket"],
  });

  let roundStartedByThisClient = false;

  socket.on("connect", async () => {
    console.log(`[socket] connected as ${socket.id}`);

    try {
      const joinResponse = await emitWithAck(socket, "blackjack:join_table", {
        tableId: options.tableId,
        playerId: options.playerId,
        playerName: options.playerName,
        balance: options.balance,
      });

      console.log(`[join] table=${joinResponse.tableId} player=${joinResponse.playerId}`);

      await emitWithAck(socket, "blackjack:place_bet", {
        amount: options.bet,
      });
      console.log(`[bet] placed $${options.bet}`);

      if (options.shouldStart) {
        await emitWithAck(socket, "blackjack:start_round");
        roundStartedByThisClient = true;
        console.log("[round] start requested");
      }
    } catch (error) {
      console.error(`[error] ${error.message}`);
      socket.disconnect();
    }
  });

  socket.on("blackjack:state", async (state) => {
    const me = state.players.find((player) => player.id === options.playerId);
    if (!me) {
      console.log("[state] player seat not present in table snapshot");
      return;
    }

    console.log(`[state] phase=${state.phase} currentPlayer=${state.currentPlayerId ?? "-"}`);
    console.log(`[me] ${me.name} | balance=${me.balance} | status=${me.status} | hand=${describeHand(me.hand)}`);

    if (state.phase === "waiting_for_bets" && options.shouldStart && !roundStartedByThisClient) {
      try {
        await emitWithAck(socket, "blackjack:start_round");
        roundStartedByThisClient = true;
        console.log("[round] start requested after waiting_for_bets state");
      } catch (error) {
        console.error(`[error] ${error.message}`);
      }
      return;
    }

    if (!options.autoPlay) {
      return;
    }

    if (state.phase !== "player_turns" || state.currentPlayerId !== options.playerId) {
      if (state.phase === "round_complete" && me.lastPayout) {
        console.log(`[result] ${me.lastPayout.result} | net=${me.lastPayout.net}`);
      }
      return;
    }

    try {
      if (me.hand.value < 17) {
        console.log("[action] hit");
        await emitWithAck(socket, "blackjack:hit");
      } else {
        console.log("[action] stand");
        await emitWithAck(socket, "blackjack:stand");
      }
    } catch (error) {
      console.error(`[error] ${error.message}`);
    }
  });

  socket.on("blackjack:error", (payload) => {
    console.error(`[server-error] ${payload.message}`);
  });

  socket.on("blackjack:session_replaced", (payload) => {
    console.log(`[session] replaced for ${payload.playerId} at table ${payload.tableId}`);
  });

  socket.on("disconnect", (reason) => {
    console.log(`[socket] disconnected: ${reason}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});