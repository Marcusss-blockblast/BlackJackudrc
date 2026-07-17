import { Card } from "../models/Card.js";
import { RANKS, SUITS } from "../constants/cards.js";

export class Deck {
  constructor(numDecks = 1) {
    this.numDecks = numDecks;
    this.cards = [];
    this.reset();
  }

  static fromSnapshot(snapshot = {}) {
    const deck = new Deck(snapshot.numDecks ?? 1);
    deck.cards = Array.isArray(snapshot.cards)
      ? snapshot.cards.map((card) => Card.fromJSON(card))
      : [];
    return deck;
  }

  reset() {
    this.cards = [];

    for (let deckIndex = 0; deckIndex < this.numDecks; deckIndex += 1) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          this.cards.push(new Card(rank, suit));
        }
      }
    }

    this.shuffle();
  }

  shuffle() {
    for (let index = this.cards.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [this.cards[index], this.cards[swapIndex]] = [this.cards[swapIndex], this.cards[index]];
    }
  }

  dealCard() {
    if (this.cards.length < 10) {
      this.reset();
    }

    return this.cards.pop();
  }

  toSnapshot() {
    return {
      numDecks: this.numDecks,
      cards: this.cards.map((card) => ({
        rank: card.rank,
        suit: card.suit,
      })),
    };
  }

  toJSON() {
    return {
      remaining: this.cards.length,
      numDecks: this.numDecks,
    };
  }
}