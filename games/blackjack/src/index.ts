/**
 * Blackjack against a dealer, with the players' cards dealt face down.
 *
 * Each hand uses a freshly shuffled 52-card deck. Every player gets two cards that only they can
 * see; the dealer gets one face up and one face down. In turn, players hit (the new card is face
 * up) or stand. Going over 21 is a bust, and turns your cards face up. The dealer then draws to 17,
 * every card is revealed, and the next hand is dealt.
 *
 * An ace and a ten-value card is a blackjack. A player's is turned up at once and they take no
 * turn. If the dealer has one, the hand ends before anyone acts.
 *
 * A blackjack scores 3, a win 2, a push 0 and a loss -2. The highest score after the last hand wins.
 *
 * Nobody's view contains the deck or the seed, and card backs are `null`. See `view`.
 */
import { createHash } from 'node:crypto';
import { produce } from 'immer';
import { defineGame, err, ok, type Outcome, type PlayerId } from '@gs/sdk';

/** Rank then suit, e.g. "AS", "TD", "7H". */
export type Card = string;

export const MAX_HANDS = 20;

export type Config = { hands: number };
export type BlackjackMove = { action: 'hit' | 'stand' };

/** `in` can still act. The rest are done for this hand. */
export type SeatStatus = 'in' | 'stood' | 'bust' | 'blackjack';

export type Seat = { cards: Card[]; status: SeatStatus; score: number };

export type HandResult = {
  hand: number;
  dealer: Card[];
  players: { [player: PlayerId]: { cards: Card[]; points: number } };
};

export type BlackjackState = {
  /** Secret: every later deck is shuffled from it. */
  seed: string;
  hands: number;
  /** 1-based number of the hand being played. */
  hand: number;
  /** Secret: the cards still to come, next one first. */
  deck: Card[];
  /** The first card is face up, the second face down until the hand ends. */
  dealer: Card[];
  /** Players in turn order. */
  order: PlayerId[];
  seats: { [player: PlayerId]: Seat };
  /** Whose turn it is, or null once the game is over. */
  turn: PlayerId | null;
  /** Finished hands, with every card revealed. */
  history: HandResult[];
};

/** A card, or null for one lying face down. */
export type VisibleCard = Card | null;

export type BlackjackView = {
  hands: number;
  hand: number;
  dealer: VisibleCard[];
  order: PlayerId[];
  seats: { [player: PlayerId]: { cards: VisibleCard[]; status: SeatStatus; score: number } };
  turn: PlayerId | null;
  history: HandResult[];
};

const RANKS = [...'A23456789TJQK'];
const SUITS = [...'SHDC'];

/** A full deck, shuffled the same way every time for the same seed and hand number. */
export function shuffledDeck(seed: string, hand: number): Card[] {
  // SHA-256 keeps the seed's full strength. A 32-bit generator could be brute-forced from the
  // cards a player can see, which would give away the ones they can't.
  let counter = 0;
  const below = (limit: number): number => {
    const unbiased = 2 ** 32 - (2 ** 32 % limit);
    for (;;) {
      const value = createHash('sha256').update(`${seed}:${hand}:${counter++}`).digest().readUInt32BE();
      if (value < unbiased) return value % limit;
    }
  };

  const deck = SUITS.flatMap((suit) => RANKS.map((rank) => rank + suit));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = below(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

/** The best total: aces count 11 unless that would bust. */
export function handValue(cards: readonly Card[]): number {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = card[0]!;
    if (rank === 'A') aces++;
    total += rank === 'A' ? 11 : 'TJQK'.includes(rank) ? 10 : Number(rank);
  }
  for (; total > 21 && aces > 0; aces--) total -= 10;
  return total;
}

const isBlackjack = (cards: readonly Card[]) => cards.length === 2 && handValue(cards) === 21;

/** Points for a player's finished hand against the dealer's. */
export function points(cards: readonly Card[], dealer: readonly Card[]): number {
  if (isBlackjack(cards) || isBlackjack(dealer)) {
    if (isBlackjack(cards) && isBlackjack(dealer)) return 0;
    return isBlackjack(cards) ? 3 : -2;
  }
  const mine = handValue(cards);
  const theirs = handValue(dealer);
  if (mine > 21) return -2;
  if (theirs > 21 || mine > theirs) return 2;
  return mine === theirs ? 0 : -2;
}

/** Deal the current hand from `deck` (next card first). Exported so tests can choose the cards. */
export function deal(state: BlackjackState, deck: readonly Card[]): BlackjackState {
  const dealt = produce(state, (draft) => {
    draft.deck = [...deck];
    draft.dealer = [];
    for (const seat of Object.values(draft.seats)) seat.cards = [];
    for (let round = 0; round < 2; round++) {
      for (const player of draft.order) draft.seats[player]!.cards.push(draft.deck.shift()!);
      draft.dealer.push(draft.deck.shift()!);
    }
    for (const seat of Object.values(draft.seats)) seat.status = isBlackjack(seat.cards) ? 'blackjack' : 'in';
  });
  return isBlackjack(dealt.dealer) ? endHand(dealt) : nextTurn(dealt);
}

/** Give the turn to the next player who can still act, or finish the hand if nobody can. */
function nextTurn(state: BlackjackState): BlackjackState {
  const turn = state.order.find((player) => state.seats[player]!.status === 'in');
  if (turn === undefined) return endHand(state);
  return produce(state, (draft) => {
    draft.turn = turn;
  });
}

/** The dealer plays, scores are settled, and the next hand (if any) is dealt. */
function endHand(state: BlackjackState): BlackjackState {
  const settled = produce(state, (draft) => {
    const seats = Object.values(draft.seats);
    if (!isBlackjack(draft.dealer) && seats.some((seat) => seat.status === 'stood')) {
      while (handValue(draft.dealer) < 17) draft.dealer.push(draft.deck.shift()!);
    }
    const result: HandResult = { hand: draft.hand, dealer: [...draft.dealer], players: {} };
    for (const player of draft.order) {
      const seat = draft.seats[player]!;
      const won = points(seat.cards, draft.dealer);
      seat.score += won;
      result.players[player] = { cards: [...seat.cards], points: won };
    }
    draft.history.push(result);
    if (draft.hand < draft.hands) draft.hand += 1;
    else draft.turn = null;
  });
  return settled.turn === null ? settled : deal(settled, shuffledDeck(settled.seed, settled.hand));
}

function outcome(state: BlackjackState): Outcome | null {
  if (state.turn !== null) return null;
  const best = Math.max(...state.order.map((player) => state.seats[player]!.score));
  const winners = state.order.filter((player) => state.seats[player]!.score === best);
  return winners.length > 1 && winners.length === state.order.length ? { draw: true } : { winners };
}

/**
 * Builds what a viewer may see field by field, instead of removing what they may not, so a new
 * state field stays secret until someone adds it here.
 */
function view(state: BlackjackState, viewer: PlayerId | null): BlackjackView {
  const over = state.turn === null;
  // Only the first two cards were dealt face down; hits are always face up.
  const seatCards = (player: PlayerId, { cards, status }: Seat): VisibleCard[] => {
    const faceUp = over || player === viewer || status === 'bust' || status === 'blackjack';
    return cards.map((card, i) => (faceUp || i >= 2 ? card : null));
  };
  return {
    hands: state.hands,
    hand: state.hand,
    dealer: state.dealer.map((card, i) => (over || i === 0 ? card : null)),
    order: state.order,
    seats: Object.fromEntries(
      Object.entries(state.seats).map(([player, seat]) => [
        player,
        { cards: seatCards(player, seat), status: seat.status, score: seat.score },
      ]),
    ),
    turn: state.turn,
    history: state.history,
  };
}

export const blackjack = defineGame<BlackjackState, BlackjackMove, Config>({
  type: 'blackjack',
  minPlayers: 1,
  maxPlayers: 6, // one deck is always enough: six busts and a dealer can't use all 52 cards

  parseConfig(input) {
    const { hands = 5 } = (input ?? {}) as { hands?: unknown };
    if (!Number.isInteger(hands) || (hands as number) < 1 || (hands as number) > MAX_HANDS) {
      return err(`hands must be an integer from 1 to ${MAX_HANDS}`);
    }
    return ok({ hands: hands as number });
  },

  setup({ players, config, seed }) {
    const state: BlackjackState = {
      seed,
      hands: config.hands,
      hand: 1,
      deck: [],
      dealer: [],
      order: players,
      seats: Object.fromEntries(players.map((player) => [player, { cards: [], status: 'in', score: 0 }])),
      turn: players[0]!,
      history: [],
    };
    return deal(state, shuffledDeck(seed, 1));
  },

  parseMove(input) {
    const action = (input as { action?: unknown } | null)?.action;
    if (action !== 'hit' && action !== 'stand') return err('Move must be { "action": "hit" } or { "action": "stand" }');
    return ok({ action });
  },

  applyMove(state, { action }, player) {
    const next = produce(state, (draft) => {
      const seat = draft.seats[player]!;
      if (action === 'stand') {
        seat.status = 'stood';
        return;
      }
      seat.cards.push(draft.deck.shift()!);
      if (handValue(seat.cards) > 21) seat.status = 'bust';
      // Reaching 21 doesn't end the turn: that would tell everyone what the face-down cards add up to.
    });
    return ok(nextTurn(next));
  },

  activePlayers: (state) => (state.turn === null ? [] : [state.turn]),
  outcome,
  view,
});
