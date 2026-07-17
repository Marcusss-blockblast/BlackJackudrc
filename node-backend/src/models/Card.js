import { SUIT_SYMBOLS } from "../constants/cards.js";

export class Card {
  constructor(rank, suit) {
    this.rank = rank;
    this.suit = suit;
  }

  static fromJSON(data = {}) {
    return new Card(data.rank, data.suit);
  }

  toString() {
    return `${this.rank}${SUIT_SYMBOLS[this.suit] ?? this.suit}`;
  }

  getValue() {
    if (["J", "Q", "K"].includes(this.rank)) {
      return 10;
    }

    if (this.rank === "A") {
      return 11;
    }

    return Number.parseInt(this.rank, 10);
  }

  toJSON() {
    return {
      rank: this.rank,
      suit: this.suit,
      label: this.toString(),
      value: this.getValue(),
    };
  }
}