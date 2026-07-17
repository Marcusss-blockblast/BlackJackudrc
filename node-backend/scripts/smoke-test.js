import { BlackjackTable } from "../src/index.js";

const table = new BlackjackTable({ tableId: "smoke-table" });

table.addPlayer({ id: "p1", name: "Alice", balance: 100 });
table.addPlayer({ id: "p2", name: "Bob", balance: 100 });

table.placeBet("p1", 10);
table.placeBet("p2", 15);

let state = table.startRound();

while (state.phase === "player_turns") {
  const currentPlayerId = state.currentPlayerId;
  const currentPlayer = state.players.find((player) => player.id === currentPlayerId);

  if (currentPlayer.hand.value < 17) {
    state = table.hit(currentPlayerId);
  } else {
    state = table.stand(currentPlayerId);
  }
}

console.log(JSON.stringify(state, null, 2));