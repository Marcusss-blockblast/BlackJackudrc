import { Hand } from "../models/Hand.js";

function createHandState({
  hand = new Hand(),
  currentBet = 0,
  lastBet = null,
  status = "waiting",
  roundResult = null,
  lastPayout = null,
  insuranceBet = 0,
  insuranceStatus = "not_offered",
  insurancePayout = null,
} = {}) {
  return {
    hand,
    currentBet,
    lastBet,
    status,
    roundResult,
    lastPayout,
    insuranceBet,
    insuranceStatus,
    insurancePayout,
  };
}

export class PlayerSeat {
  constructor({
    id,
    name,
    balance = 100,
  }) {
    this.id = id;
    this.name = name;
    this.balance = balance;

    this.hands = [createHandState()];
    this.activeHandIndex = 0;
    this.history = [];
  }

  static fromSnapshot(snapshot = {}) {
    const player = new PlayerSeat({
      id: snapshot.id,
      name: snapshot.name,
      balance: snapshot.balance ?? 100,
    });

    const handSnapshots = Array.isArray(snapshot.hands) && snapshot.hands.length > 0
      ? snapshot.hands
      : [
        {
          hand: snapshot.hand,
          currentBet: snapshot.currentBet ?? 0,
          lastBet: snapshot.lastBet ?? null,
          status: snapshot.status ?? "waiting",
          roundResult: snapshot.roundResult ?? null,
          lastPayout: snapshot.lastPayout ? { ...snapshot.lastPayout } : null,
          insuranceBet: snapshot.insuranceBet ?? 0,
          insuranceStatus: snapshot.insuranceStatus ?? "not_offered",
          insurancePayout: snapshot.insurancePayout ? { ...snapshot.insurancePayout } : null,
        },
      ];

    player.hands = handSnapshots.map((handSnapshot) => createHandState({
      hand: Hand.fromSnapshot(handSnapshot.hand),
      currentBet: handSnapshot.currentBet ?? 0,
      lastBet: handSnapshot.lastBet ?? null,
      status: handSnapshot.status ?? "waiting",
      roundResult: handSnapshot.roundResult ?? null,
      lastPayout: handSnapshot.lastPayout ? { ...handSnapshot.lastPayout } : null,
      insuranceBet: handSnapshot.insuranceBet ?? 0,
      insuranceStatus: handSnapshot.insuranceStatus ?? "not_offered",
      insurancePayout: handSnapshot.insurancePayout ? { ...handSnapshot.insurancePayout } : null,
    }));
    player.activeHandIndex = Math.min(
      Math.max(snapshot.activeHandIndex ?? 0, 0),
      Math.max(player.hands.length - 1, 0),
    );
    player.history = Array.isArray(snapshot.history)
      ? snapshot.history.map((entry) => ({ ...entry }))
      : [];

    return player;
  }

  get hand() {
    return this.#getActiveHandState().hand;
  }

  set hand(value) {
    this.#getActiveHandState().hand = value;
  }

  get currentBet() {
    return this.#getActiveHandState().currentBet;
  }

  set currentBet(value) {
    this.#getActiveHandState().currentBet = value;
  }

  get lastBet() {
    return this.#getActiveHandState().lastBet;
  }

  set lastBet(value) {
    this.#getActiveHandState().lastBet = value;
  }

  get status() {
    return this.#getActiveHandState().status;
  }

  set status(value) {
    this.#getActiveHandState().status = value;
  }

  get roundResult() {
    return this.#getActiveHandState().roundResult;
  }

  set roundResult(value) {
    this.#getActiveHandState().roundResult = value;
  }

  get lastPayout() {
    return this.#getActiveHandState().lastPayout;
  }

  set lastPayout(value) {
    this.#getActiveHandState().lastPayout = value;
  }

  resetForRound() {
    const currentBet = this.hands[0]?.currentBet ?? 0;
    const lastBet = this.hands[0]?.lastBet ?? null;
    this.hands = [createHandState({
      currentBet,
      lastBet,
      status: currentBet > 0 ? "in_round" : "waiting",
    })];
    this.activeHandIndex = 0;
  }

  canTakeInsurance(handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);
    return Boolean(
      handState.currentBet >= 2
        && handState.hand.cards.length === 2
        && handState.insuranceStatus === "available"
        && this.balance >= this.getInsuranceAmount(handIndex),
    );
  }

  getInsuranceAmount(handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);
    return Math.floor(handState.currentBet / 2);
  }

  offerInsurance(handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);
    if (handState.currentBet >= 2 && handState.hand.cards.length === 2) {
      handState.insuranceStatus = "available";
      handState.insuranceBet = 0;
      handState.insurancePayout = null;
      return true;
    }

    handState.insuranceStatus = "not_offered";
    handState.insuranceBet = 0;
    handState.insurancePayout = null;
    return false;
  }

  takeInsurance(handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);
    const insuranceAmount = this.getInsuranceAmount(handIndex);
    if (!this.canTakeInsurance(handIndex) || insuranceAmount <= 0) {
      return false;
    }

    this.balance -= insuranceAmount;
    handState.insuranceBet = insuranceAmount;
    handState.insuranceStatus = "taken";
    handState.insurancePayout = null;
    return true;
  }

  declineInsurance(handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);
    if (handState.insuranceStatus !== "available") {
      return false;
    }

    handState.insuranceStatus = "declined";
    handState.insuranceBet = 0;
    handState.insurancePayout = {
      result: "declined",
      net: 0,
      bet: 0,
      handIndex,
    };
    return true;
  }

  resolveInsurance(dealerBlackjack, handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);
    if (handState.insuranceStatus === "not_offered") {
      return null;
    }

    if (handState.insuranceStatus === "available") {
      this.declineInsurance(handIndex);
    }

    if (handState.insuranceBet <= 0) {
      return handState.insurancePayout;
    }

    if (dealerBlackjack) {
      const payout = handState.insuranceBet * 3;
      this.balance += payout;
      handState.insuranceStatus = "won";
      handState.insurancePayout = {
        result: "won",
        net: handState.insuranceBet * 2,
        payout,
        bet: handState.insuranceBet,
        handIndex,
      };
      return handState.insurancePayout;
    }

    handState.insuranceStatus = "lost";
    handState.insurancePayout = {
      result: "lost",
      net: -handState.insuranceBet,
      payout: 0,
      bet: handState.insuranceBet,
      handIndex,
    };
    return handState.insurancePayout;
  }

  placeBet(amount) {
    if (amount <= 0) {
      return false;
    }

    const activeHandState = this.#getActiveHandState();
    const refundablePendingBet = activeHandState.status === "bet_placed" ? activeHandState.currentBet : 0;
    const availableBalance = this.balance + refundablePendingBet;

    if (amount > availableBalance) {
      return false;
    }

    if (refundablePendingBet > 0) {
      this.balance += refundablePendingBet;
    }

    this.balance -= amount;
    this.hands = [createHandState({
      currentBet: amount,
      lastBet: amount,
      status: "bet_placed",
    })];
    this.activeHandIndex = 0;
    return true;
  }

  hit(deck) {
    const handState = this.#getActiveHandState();
    handState.hand.addCard(deck.dealCard());
    return handState.hand.getValue() <= 21;
  }

  doubleDown(deck) {
    const handState = this.#getActiveHandState();
    if (handState.currentBet <= 0 || handState.hand.cards.length !== 2 || this.balance < handState.currentBet) {
      return false;
    }

    this.balance -= handState.currentBet;
    handState.currentBet *= 2;
    handState.lastBet = handState.currentBet;
    handState.hand.addCard(deck.dealCard());
    return true;
  }

  split(deck) {
    const handState = this.#getActiveHandState();
    const [firstCard, secondCard] = handState.hand.cards;
    const canSplit = Boolean(
      handState.currentBet > 0
        && handState.hand.cards.length === 2
        && firstCard
        && secondCard
        && firstCard.getValue() === secondCard.getValue()
        && this.balance >= handState.currentBet,
    );

    if (!canSplit) {
      return false;
    }

    this.balance -= handState.currentBet;

    const firstHand = Hand.fromSnapshot({ cards: [{ rank: firstCard.rank, suit: firstCard.suit }] });
    const secondHand = Hand.fromSnapshot({ cards: [{ rank: secondCard.rank, suit: secondCard.suit }] });
    firstHand.addCard(deck.dealCard());
    secondHand.addCard(deck.dealCard());

    const splitBet = handState.currentBet;
    this.hands.splice(
      this.activeHandIndex,
      1,
      createHandState({
        hand: firstHand,
        currentBet: splitBet,
        lastBet: splitBet,
        status: "in_round",
        insuranceStatus: "not_offered",
      }),
      createHandState({
        hand: secondHand,
        currentBet: splitBet,
        lastBet: splitBet,
        status: "in_round",
        insuranceStatus: "not_offered",
      }),
    );

    return true;
  }

  surrender() {
    const refund = Math.floor((this.currentBet + 1) / 2);
    this.balance += refund;
    return this.#finalizeRound(this.activeHandIndex, "surrender", -this.currentBet + refund, { refund });
  }

  settle(result, handIndex = this.activeHandIndex) {
    const handState = this.#getHandState(handIndex);

    if (result === "blackjack") {
      const winnings = Math.trunc(handState.currentBet * 2.5);
      const bonus = handState.currentBet >= 10 ? Math.max(1, Math.trunc(handState.currentBet * 0.1)) : 0;
      const totalWinnings = winnings + bonus;
      this.balance += totalWinnings;
      return this.#finalizeRound(handIndex, result, totalWinnings - handState.currentBet, { winnings: totalWinnings, bonus });
    }

    if (result === "win") {
      const winnings = handState.currentBet * 2;
      this.balance += winnings;
      return this.#finalizeRound(handIndex, result, handState.currentBet, { winnings });
    }

    if (result === "push") {
      this.balance += handState.currentBet;
      return this.#finalizeRound(handIndex, result, 0, { winnings: handState.currentBet });
    }

    if (result === "lose" || result === "bust") {
      return this.#finalizeRound(handIndex, result, -handState.currentBet, { winnings: 0 });
    }

    throw new Error(`Unsupported settlement result: ${result}`);
  }

  advanceToNextHand() {
    for (let index = this.activeHandIndex + 1; index < this.hands.length; index += 1) {
      if (this.hands[index].status === "in_round") {
        this.activeHandIndex = index;
        return true;
      }
    }

    return false;
  }

  resetActiveHandToFirstPlayable() {
    for (let index = 0; index < this.hands.length; index += 1) {
      if (this.hands[index].status === "in_round") {
        this.activeHandIndex = index;
        return true;
      }
    }

    return false;
  }

  getSettlingHandIndexes() {
    return this.hands
      .map((handState, index) => ({ handState, index }))
      .filter(({ handState }) => handState.status === "stood" || handState.status === "in_round")
      .map(({ index }) => index);
  }

  getPlayableHandIndexes() {
    return this.hands
      .map((handState, index) => ({ handState, index }))
      .filter(({ handState }) => ["in_round", "bet_placed"].includes(handState.status) && handState.currentBet > 0)
      .map(({ index }) => index);
  }

  getHand(index) {
    return this.#getHandState(index).hand;
  }

  #finalizeRound(handIndex, result, net, meta = {}) {
    const handState = this.#getHandState(handIndex);
    const settledBet = handState.currentBet;
    handState.roundResult = result;
    handState.status = "done";
    handState.lastPayout = {
      result,
      net,
      bet: settledBet,
      handIndex,
      ...meta,
    };
    handState.currentBet = 0;
    this.history.push(handState.lastPayout);
    return handState.lastPayout;
  }

  #getActiveHandState() {
    return this.#getHandState(this.activeHandIndex);
  }

  #getHandState(index) {
    return this.hands[index] ?? this.hands[0];
  }

  toSnapshot() {
    return {
      id: this.id,
      name: this.name,
      balance: this.balance,
      activeHandIndex: this.activeHandIndex,
      hands: this.hands.map((handState) => ({
        currentBet: handState.currentBet,
        lastBet: handState.lastBet,
        status: handState.status,
        roundResult: handState.roundResult,
        lastPayout: handState.lastPayout ? { ...handState.lastPayout } : null,
        insuranceBet: handState.insuranceBet,
        insuranceStatus: handState.insuranceStatus,
        insurancePayout: handState.insurancePayout ? { ...handState.insurancePayout } : null,
        hand: handState.hand.toSnapshot(),
      })),
      history: this.history.map((entry) => ({ ...entry })),
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      balance: this.balance,
      activeHandIndex: this.activeHandIndex,
      handCount: this.hands.length,
      currentBet: this.currentBet,
      lastBet: this.lastBet,
      status: this.status,
      roundResult: this.roundResult,
      lastPayout: this.lastPayout,
      hand: this.hand.toJSON(),
      hands: this.hands.map((handState, index) => ({
        index,
        isActive: index === this.activeHandIndex,
        currentBet: handState.currentBet,
        lastBet: handState.lastBet,
        status: handState.status,
        roundResult: handState.roundResult,
        lastPayout: handState.lastPayout,
        insuranceBet: handState.insuranceBet,
        insuranceStatus: handState.insuranceStatus,
        insurancePayout: handState.insurancePayout,
        hand: handState.hand.toJSON(),
      })),
    };
  }
}