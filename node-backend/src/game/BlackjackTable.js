import { Deck } from "./Deck.js";
import { Hand } from "../models/Hand.js";
import { PlayerSeat } from "./PlayerSeat.js";

export class BlackjackTable {
  constructor({ tableId = "table-1", numDecks = 1, onChange = null } = {}) {
    this.tableId = tableId;
    this.deck = new Deck(numDecks);
    this.dealerHand = new Hand();
    this.players = [];
    this.phase = "waiting_for_players";
    this.currentPlayerIndex = null;
    this.stateVersion = 0;
    this.onChange = onChange;
  }

  static fromSnapshot(snapshot = {}, { onChange = null } = {}) {
    const table = new BlackjackTable({
      tableId: snapshot.tableId ?? "table-1",
      numDecks: snapshot.deck?.numDecks ?? 1,
      onChange,
    });

    table.deck = Deck.fromSnapshot(snapshot.deck ?? { numDecks: 1, cards: [] });
    table.dealerHand = Hand.fromSnapshot(snapshot.dealerHand);
    table.players = Array.isArray(snapshot.players)
      ? snapshot.players.map((player) => PlayerSeat.fromSnapshot(player))
      : [];
    table.phase = snapshot.phase ?? "waiting_for_players";
    table.currentPlayerIndex = snapshot.currentPlayerIndex ?? null;
    table.stateVersion = snapshot.stateVersion ?? 0;

    return table;
  }

  addPlayer(playerConfig) {
    if (this.players.some((player) => player.id === playerConfig.id)) {
      throw new Error(`Player ${playerConfig.id} is already seated at table ${this.tableId}.`);
    }

    const player = new PlayerSeat(playerConfig);
    this.players.push(player);
    this.#bumpState();
    this.#syncWaitingPhase();
    return player;
  }

  removePlayer(playerId) {
    const removedIndex = this.players.findIndex((player) => player.id === playerId);
    if (removedIndex === -1) {
      return;
    }

    const wasCurrentPlayer = this.currentPlayerIndex === removedIndex;
    this.players.splice(removedIndex, 1);

    if (this.players.length === 0) {
      this.currentPlayerIndex = null;
      this.#bumpState();
      this.#syncWaitingPhase();
      return;
    }

    if (this.phase === "player_turns") {
      if (wasCurrentPlayer) {
        const nextIndex = this.#findNextTurnIndex(removedIndex - 1);
        if (nextIndex === null) {
          this.#finishDealerAndRound();
        } else {
          this.currentPlayerIndex = nextIndex;
        }
      } else if (this.currentPlayerIndex !== null && removedIndex < this.currentPlayerIndex) {
        this.currentPlayerIndex -= 1;
      }
    } else if (this.currentPlayerIndex !== null && this.currentPlayerIndex >= this.players.length) {
      this.currentPlayerIndex = this.players.length - 1;
    }

    this.#bumpState();
    this.#syncWaitingPhase();
  }

  placeBet(playerId, amount) {
    if (!["waiting_for_players", "waiting_for_bets", "round_complete"].includes(this.phase)) {
      throw new Error("Bets can only be placed before a round starts.");
    }

    const player = this.#getPlayer(playerId);
    const placed = player.placeBet(amount);
    if (!placed) {
      throw new Error(`Unable to place bet ${amount} for player ${playerId}.`);
    }

    this.phase = "waiting_for_bets";
    this.#bumpState();
    return player.toJSON();
  }

  shouldAutoStartRound() {
    return ["waiting_for_players", "waiting_for_bets", "round_complete"].includes(this.phase)
      && this.players.length > 0
      && this.players.every((player) => player.currentBet > 0);
  }

  startRound() {
    if (!["waiting_for_bets", "round_complete", "waiting_for_players"].includes(this.phase)) {
      throw new Error(`Cannot start a round during phase ${this.phase}.`);
    }

    const activePlayers = this.#getBettingPlayers();
    if (activePlayers.length === 0) {
      throw new Error("At least one player with a bet is required to start a round.");
    }

    this.dealerHand.reset();
    for (const player of this.players) {
      player.resetForRound();
    }

    for (const player of activePlayers) {
      player.hand.addCard(this.deck.dealCard());
    }
    this.dealerHand.addCard(this.deck.dealCard());

    for (const player of activePlayers) {
      player.hand.addCard(this.deck.dealCard());
    }
    this.dealerHand.addCard(this.deck.dealCard());

    if (this.#prepareInsurancePhase()) {
      this.#bumpState();
      return this.serializeState();
    }

    this.phase = "player_turns";
    this.currentPlayerIndex = this.#findNextTurnIndex(-1);
    this.#resolveNaturals();
    this.#bumpState();
    return this.serializeState();
  }

  hit(playerId) {
    const player = this.#requireCurrentPlayer(playerId);
    const safe = player.hit(this.deck);

    if (!safe) {
      player.settle("bust");
      this.#advanceTurn();
    }

    this.#bumpState();
    return this.serializeState();
  }

  stand(playerId) {
    const player = this.#requireCurrentPlayer(playerId);
    player.status = "stood";
    this.#advanceTurn();
    this.#bumpState();
    return this.serializeState();
  }

  surrender(playerId) {
    const player = this.#requireCurrentPlayer(playerId);
    player.surrender();
    this.#advanceTurn();
    this.#bumpState();
    return this.serializeState();
  }

  split(playerId) {
    const player = this.#requireCurrentPlayer(playerId);

    if (!player.split(this.deck)) {
      throw new Error("Split requires a matching two-card hand and enough balance to match the bet.");
    }

    this.#bumpState();
    return this.serializeState();
  }

  takeInsurance(playerId) {
    const player = this.#requireInsurancePlayer(playerId);

    if (!player.takeInsurance()) {
      throw new Error("Insurance is only available on a two-card hand with enough balance to cover half the bet.");
    }

    this.#advanceInsuranceTurn();
    this.#bumpState();
    return this.serializeState();
  }

  declineInsurance(playerId) {
    const player = this.#requireInsurancePlayer(playerId);

    if (!player.declineInsurance()) {
      throw new Error("Insurance is not available for this player.");
    }

    this.#advanceInsuranceTurn();
    this.#bumpState();
    return this.serializeState();
  }

  doubleDown(playerId) {
    const player = this.#requireCurrentPlayer(playerId);

    if (!player.doubleDown(this.deck)) {
      throw new Error("Double down requires an initial two-card hand and enough balance to match the bet.");
    }

    if (player.hand.getValue() > 21) {
      player.settle("bust");
    } else {
      player.status = "stood";
    }

    this.#advanceTurn();
    this.#bumpState();
    return this.serializeState();
  }

  dealerPlay() {
    while (this.dealerHand.getValue() < 17) {
      this.dealerHand.addCard(this.deck.dealCard());
    }
  }

  determineWinner(playerHand) {
    const playerValue = playerHand.getValue();
    const dealerValue = this.dealerHand.getValue();

    if (playerValue > 21) {
      return "bust";
    }

    if (dealerValue > 21) {
      return "win";
    }

    if (playerValue > dealerValue) {
      return "win";
    }

    if (playerValue < dealerValue) {
      return "lose";
    }

    return "push";
  }

  serializeState({ viewerPlayerId = null, revealDealerHole = false } = {}) {
    const currentPlayer = this.getCurrentPlayer();

    // This snapshot is the backend contract a Socket.IO/ws layer would broadcast.
    // Keep one table instance per room and emit this object after every state change.
    return {
      tableId: this.tableId,
      phase: this.phase,
      stateVersion: this.stateVersion,
      currentPlayerId: currentPlayer?.id ?? null,
      currentHandIndex: currentPlayer?.activeHandIndex ?? null,
      insuranceActive: this.phase === "insurance",
      deck: this.deck.toJSON(),
      dealer: this.#serializeDealer(revealDealerHole || this.phase === "round_complete" || this.phase === "dealer_turn"),
      players: this.players.map((player) => ({
        ...player.toJSON(),
        canAct: currentPlayer?.id === player.id,
        isViewer: viewerPlayerId === player.id,
      })),
    };
  }

  getCurrentPlayer() {
    if (this.currentPlayerIndex === null) {
      return null;
    }

    return this.players[this.currentPlayerIndex] ?? null;
  }

  toSnapshot() {
    return {
      tableId: this.tableId,
      phase: this.phase,
      currentPlayerIndex: this.currentPlayerIndex,
      stateVersion: this.stateVersion,
      deck: this.deck.toSnapshot(),
      dealerHand: this.dealerHand.toSnapshot(),
      players: this.players.map((player) => player.toSnapshot()),
    };
  }

  #resolveNaturals() {
    const activePlayers = this.#getPlayersStillInRound();
    const dealerBlackjack = this.dealerHand.isBlackjack();

    for (const player of activePlayers) {
      const playerBlackjack = player.hand.isBlackjack();

      if (!playerBlackjack && !dealerBlackjack) {
        continue;
      }

      if (playerBlackjack && dealerBlackjack) {
        player.settle("push");
      } else if (playerBlackjack) {
        player.settle("blackjack");
      } else {
        player.settle("lose");
      }
    }

    if (dealerBlackjack) {
      this.currentPlayerIndex = null;
      this.phase = "round_complete";
      return;
    }

    this.currentPlayerIndex = this.#findNextTurnIndex(-1);
    if (this.currentPlayerIndex === null) {
      this.#finishDealerAndRound();
    }
  }

  #prepareInsurancePhase() {
    const dealerUpCard = this.dealerHand.cards[0] ?? null;
    if (dealerUpCard?.rank !== "A") {
      return false;
    }

    let hasInsuranceOffer = false;
    for (const player of this.players) {
      if (player.offerInsurance()) {
        hasInsuranceOffer = true;
      }
    }

    if (!hasInsuranceOffer) {
      return false;
    }

    this.phase = "insurance";
    this.currentPlayerIndex = this.#findNextInsuranceIndex(-1);
    if (this.currentPlayerIndex === null) {
      this.#finishInsurancePhase();
      return false;
    }

    return true;
  }

  #advanceInsuranceTurn() {
    const currentIndex = this.currentPlayerIndex ?? -1;
    const nextIndex = this.#findNextInsuranceIndex(currentIndex);

    if (nextIndex === null) {
      this.#finishInsurancePhase();
      return;
    }

    this.currentPlayerIndex = nextIndex;
  }

  #finishInsurancePhase() {
    const dealerBlackjack = this.dealerHand.isBlackjack();
    for (const player of this.players) {
      player.resolveInsurance(dealerBlackjack);
    }

    this.phase = "player_turns";
    this.currentPlayerIndex = this.#findNextTurnIndex(-1);
    this.#resolveNaturals();
  }

  #advanceTurn() {
    const currentPlayer = this.getCurrentPlayer();
    if (currentPlayer?.advanceToNextHand()) {
      return;
    }

    const currentIndex = this.currentPlayerIndex ?? -1;
    const nextIndex = this.#findNextTurnIndex(currentIndex);

    if (nextIndex === null) {
      this.#finishDealerAndRound();
      return;
    }

    this.currentPlayerIndex = nextIndex;
  }

  #finishDealerAndRound() {
    const pendingPlayers = this.players.filter((player) => player.getSettlingHandIndexes().length > 0);

    if (pendingPlayers.length > 0) {
      this.phase = "dealer_turn";
      this.dealerPlay();

      for (const player of pendingPlayers) {
        for (const handIndex of player.getSettlingHandIndexes()) {
          const result = this.determineWinner(player.getHand(handIndex));
          player.settle(result, handIndex);
        }
      }
    }

    this.currentPlayerIndex = null;
    this.phase = "round_complete";
  }

  #serializeDealer(revealDealerHole) {
    if (revealDealerHole) {
      return this.dealerHand.toJSON();
    }

    const visibleCard = this.dealerHand.cards[0] ?? null;
    return {
      cards: visibleCard ? [visibleCard.toJSON(), { hidden: true }] : [],
      value: null,
      hardValue: null,
      softValue: null,
      alternateValue: null,
      isBlackjack: false,
    };
  }

  #getPlayer(playerId) {
    const player = this.players.find((candidate) => candidate.id === playerId);
    if (!player) {
      throw new Error(`Player ${playerId} is not seated at table ${this.tableId}.`);
    }

    return player;
  }

  #requireCurrentPlayer(playerId) {
    if (this.phase !== "player_turns") {
      throw new Error(`Player actions are not allowed during phase ${this.phase}.`);
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.id !== playerId) {
      throw new Error(`It is not player ${playerId}'s turn.`);
    }

    return currentPlayer;
  }

  #requireInsurancePlayer(playerId) {
    if (this.phase !== "insurance") {
      throw new Error(`Insurance is not available during phase ${this.phase}.`);
    }

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.id !== playerId) {
      throw new Error(`It is not player ${playerId}'s insurance turn.`);
    }

    return currentPlayer;
  }

  #getBettingPlayers() {
    return this.players.filter((player) => player.currentBet > 0);
  }

  #getPlayersStillInRound() {
    return this.players.filter((player) => player.getPlayableHandIndexes().length > 0);
  }

  #findNextTurnIndex(fromIndex) {
    for (let index = fromIndex + 1; index < this.players.length; index += 1) {
      const player = this.players[index];
      if (player.resetActiveHandToFirstPlayable()) {
        return index;
      }
    }

    return null;
  }

  #findNextInsuranceIndex(fromIndex) {
    for (let index = fromIndex + 1; index < this.players.length; index += 1) {
      const player = this.players[index];
      if (player.hands.some((handState) => handState.insuranceStatus === "available")) {
        player.activeHandIndex = 0;
        return index;
      }
    }

    return null;
  }

  #syncWaitingPhase() {
    if (this.players.length === 0) {
      this.phase = "waiting_for_players";
    } else if (["waiting_for_players", "round_complete"].includes(this.phase)) {
      this.phase = "waiting_for_bets";
    }
  }

  #bumpState() {
    this.stateVersion += 1;
    this.onChange?.(this);
  }
}