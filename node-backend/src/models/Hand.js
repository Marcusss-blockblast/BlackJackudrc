import { Card } from "./Card.js";

export class Hand {
  constructor() {
    this.cards = [];
  }

  static fromSnapshot(snapshot = {}) {
    const hand = new Hand();
    hand.cards = Array.isArray(snapshot.cards)
      ? snapshot.cards.map((card) => Card.fromJSON(card))
      : [];
    return hand;
  }

  addCard(card) {
    this.cards.push(card);
  }

  reset() {
    this.cards = [];
  }

  getValue() {
    let total = 0;
    let aces = 0;

    for (const card of this.cards) {
      if (card.rank === "A") {
        aces += 1;
      }

      total += card.getValue();
    }

    while (total > 21 && aces > 0) {
      total -= 10;
      aces -= 1;
    }

    return total;
  }

  hasAce() {
    return this.cards.some((card) => card.rank === "A");
  }

  getHardValue() {
    let total = 0;

    for (const card of this.cards) {
      total += card.rank === "A" ? 1 : card.getValue();
    }

    return total;
  }

  getSoftValue() {
    if (!this.hasAce()) {
      return null;
    }

    const soft = this.getHardValue() + 10;
    return soft <= 21 ? soft : null;
  }

  getAlternateValue() {
    const soft = this.getSoftValue();
    if (soft === null) {
      return null;
    }

    const hard = this.getHardValue();
    const best = this.getValue();

    if (best === soft) {
      return hard;
    }

    if (best === hard) {
      return soft;
    }

    return null;
  }

  isBlackjack() {
    if (this.cards.length !== 2) {
      return false;
    }

    const hasAce = this.cards.some((card) => card.rank === "A");
    const hasTenValue = this.cards.some((card) => card.rank !== "A" && card.getValue() === 10);
    return hasAce && hasTenValue;
  }

  toSnapshot() {
    return {
      cards: this.cards.map((card) => ({
        rank: card.rank,
        suit: card.suit,
      })),
    };
  }

  toJSON() {
    return {
      cards: this.cards.map((card) => card.toJSON()),
      value: this.getValue(),
      hardValue: this.getHardValue(),
      softValue: this.getSoftValue(),
      alternateValue: this.getAlternateValue(),
      isBlackjack: this.isBlackjack(),
    };
  }
}