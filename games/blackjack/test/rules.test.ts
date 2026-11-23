import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result } from '@gs/sdk';
import {
  blackjack,
  deal,
  handValue,
  points,
  shuffledDeck,
  type BlackjackState,
  type BlackjackView,
  type Card,
} from '../src/index.ts';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const cards = (text: string): Card[] => text.split(' ');

function start(players: string[], config: unknown = { hands: 1 }, seed = 'seed'): BlackjackState {
  return blackjack.setup({ players, config: unwrap(blackjack.parseConfig(config)), seed, now: 0 });
}

/**
 * A game whose current hand is dealt from these cards. They come out one at a time round the table,
 * dealer last, twice; whatever is left is drawn in order.
 */
function dealt(players: string[], deck: string, config: unknown = { hands: 1 }): BlackjackState {
  const fresh: BlackjackState = {
    seed: 'seed',
    hands: unwrap(blackjack.parseConfig(config)).hands,
    hand: 1,
    deck: [],
    dealer: [],
    order: players,
    seats: Object.fromEntries(players.map((p) => [p, { cards: [], status: 'in', score: 0 }])),
    turn: players[0]!,
    history: [],
  };
  return deal(fresh, cards(deck));
}

/** Make moves in order, parsing then applying, as the server does. */
function play(state: BlackjackState, ...actions: ('hit' | 'stand')[]): BlackjackState {
  for (const action of actions) {
    const [player] = blackjack.activePlayers(state) as [string];
    const move = unwrap(blackjack.parseMove({ action }, state, player));
    state = unwrap(blackjack.applyMove(state, move, player, { now: 0 }));
  }
  return state;
}

const view = (state: BlackjackState, viewer: string | null) => blackjack.view!(state, viewer) as BlackjackView;

/** a has T 9, b has 5 6, the dealer shows K with a 7 underneath; 8 then 4 then T come next. */
const TABLE = 'TS 5S KS 9S 6S 7S 8H 4H TH';

describe('blackjack cards', () => {
  it('counts hands, with aces as 11 or 1', () => {
    assert.equal(handValue(cards('TS JS')), 20);
    assert.equal(handValue(cards('AS KS')), 21);
    assert.equal(handValue(cards('AS AH')), 12);
    assert.equal(handValue(cards('AS 9S AH')), 21);
    assert.equal(handValue(cards('AS 9S 5H')), 15);
    assert.equal(handValue(cards('TS 9S 5H')), 24);
  });

  it('scores a hand against the dealer', () => {
    assert.equal(points(cards('TS 9S'), cards('TH 8S')), 2);
    assert.equal(points(cards('TS 8S'), cards('TH 8H')), 0);
    assert.equal(points(cards('TS 7S'), cards('TH 8S')), -2);
    assert.equal(points(cards('TS 7S'), cards('TH 6S 9H')), 2); // dealer busts
    assert.equal(points(cards('TS 7S 5S'), cards('TH 6S 9H')), -2); // a bust loses even if the dealer busts
    assert.equal(points(cards('AS KS'), cards('TH 5S 6H')), 3); // beats a three-card 21
    assert.equal(points(cards('AS KS'), cards('AH KH')), 0);
    assert.equal(points(cards('TS 5S 6S'), cards('AH KH')), -2);
  });

  it('shuffles all 52 cards, the same way for the same seed and hand', () => {
    const deck = shuffledDeck('s', 1);
    assert.equal(new Set(deck).size, 52);
    assert.deepEqual(shuffledDeck('s', 1), deck);
    assert.notDeepEqual(shuffledDeck('s', 2), deck);
    assert.notDeepEqual(shuffledDeck('t', 1), deck);
    assert.deepEqual(start(['a', 'b']), start(['a', 'b']));
  });
});

describe('blackjack rules', () => {
  it('validates config and moves', () => {
    assert.deepEqual(unwrap(blackjack.parseConfig(undefined)), { hands: 5 });
    for (const hands of [0, 21, 1.5, '3']) assert.equal(blackjack.parseConfig({ hands }).ok, false, String(hands));
    const state = dealt(['a', 'b'], TABLE);
    for (const bad of [null, undefined, 'hit', {}, { action: 'double' }]) {
      assert.equal(blackjack.parseMove(bad, state, 'a').ok, false, JSON.stringify(bad));
    }
  });

  it('gives each player a turn until they stand, then the dealer draws to 17 and scores settle', () => {
    let state = dealt(['a', 'b'], TABLE);
    assert.deepEqual(blackjack.activePlayers(state), ['a']);
    state = play(state, 'stand');
    assert.deepEqual(blackjack.activePlayers(state), ['b']);
    state = play(state, 'hit');
    assert.deepEqual(blackjack.activePlayers(state), ['b']); // a hit keeps the turn
    assert.deepEqual(state.seats.b!.cards, cards('5S 6S 8H'));
    state = play(state, 'stand');

    assert.deepEqual(blackjack.activePlayers(state), []);
    assert.deepEqual(state.history, [
      {
        hand: 1,
        dealer: cards('KS 7S'), // already 17, so no draw
        players: { a: { cards: cards('TS 9S'), points: 2 }, b: { cards: cards('5S 6S 8H'), points: 2 } },
      },
    ]);
    assert.deepEqual(blackjack.outcome(state), { draw: true });
  });

  it('a bust ends the turn and loses; the dealer draws below 17', () => {
    let state = dealt(['a', 'b'], 'TS TD 2S 9S 8D 3S KC TC 9C');
    state = play(state, 'hit'); // a: T 9 K
    assert.equal(state.seats.a!.status, 'bust');
    assert.deepEqual(blackjack.activePlayers(state), ['b']);
    state = play(state, 'stand');
    assert.deepEqual(state.history[0]!.dealer, cards('2S 3S TC 9C'));
    assert.deepEqual(blackjack.outcome(state), { winners: ['b'] });
  });

  it('the dealer draws nothing when everyone has bust', () => {
    const state = play(dealt(['a'], 'TS 2S 9S 3S KC TC'), 'hit');
    assert.deepEqual(state.history[0]!.dealer, cards('2S 3S'));
    assert.deepEqual(blackjack.outcome(state), { winners: ['a'] }); // the only player
  });

  it('a player with a blackjack takes no turn and scores 3', () => {
    let state = dealt(['a', 'b'], 'AS TD TH KS 8D 8H');
    assert.deepEqual(blackjack.activePlayers(state), ['b']);
    state = play(state, 'stand'); // b pushes on 18
    assert.equal(state.seats.a!.score, 3);
    assert.equal(state.seats.b!.score, 0);
    assert.deepEqual(blackjack.outcome(state), { winners: ['a'] });
  });

  it('a dealer blackjack ends the hand before anyone acts', () => {
    const state = dealt(['a', 'b'], 'AS TD AH KS 8D KH');
    assert.deepEqual(blackjack.activePlayers(state), []);
    assert.equal(state.seats.a!.score, 0); // blackjack against blackjack
    assert.equal(state.seats.b!.score, -2);
  });

  it('deals the next hand from a new deck, keeping scores', () => {
    const state = play(dealt(['a', 'b'], TABLE, { hands: 2 }), 'stand', 'stand');
    assert.equal(state.hand, 2);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0]!.players.a!.points, 2);
    const inPlay = [...state.deck, ...state.dealer, ...Object.values(state.seats).flatMap((s) => s.cards)];
    assert.deepEqual([...inPlay].sort(), shuffledDeck('seed', 2).sort());
  });

  it('always finishes, with the maximum number of players hitting until they bust', () => {
    for (let seed = 0; seed < 200; seed++) {
      let state = start(['a', 'b', 'c', 'd', 'e', 'f'], { hands: 2 }, String(seed));
      while (blackjack.outcome(state) === null) state = play(state, 'hit');
      assert.equal(state.history.length, 2);
    }
  });
});

describe('blackjack views', () => {
  it('shows you your own cards, and the backs of everyone else’s', () => {
    const state = dealt(['a', 'b'], TABLE);
    const mine = view(state, 'a');
    assert.deepEqual(mine.seats.a!.cards, cards('TS 9S'));
    assert.deepEqual(mine.seats.b!.cards, [null, null]);
    assert.deepEqual(mine.dealer, ['KS', null]);
    assert.deepEqual(view(state, 'b').seats.a!.cards, [null, null]);
    assert.deepEqual(view(state, 'b').seats.b!.cards, cards('5S 6S'));
  });

  it('shows spectators only face-up cards', () => {
    const seen = view(dealt(['a', 'b'], TABLE), null);
    assert.deepEqual(seen.seats.a!.cards, [null, null]);
    assert.deepEqual(seen.seats.b!.cards, [null, null]);
    assert.deepEqual(seen.dealer, ['KS', null]);
  });

  it('hits are face up, and standing keeps the first two cards hidden', () => {
    const state = play(dealt(['a', 'b'], TABLE), 'stand', 'hit');
    for (const viewer of ['a', null]) assert.deepEqual(view(state, viewer).seats.b!.cards, [null, null, '8H']);
    for (const viewer of ['b', null]) assert.deepEqual(view(state, viewer).seats.a!.cards, [null, null]);
  });

  it('a bust or a blackjack turns the cards face up', () => {
    const bust = play(dealt(['a', 'b'], 'TS TD 2S 9S 8D 3S KC'), 'hit');
    assert.deepEqual(view(bust, 'b').seats.a!.cards, cards('TS 9S KC'));
    const natural = dealt(['a', 'b'], 'AS TD TH KS 8D 8H');
    assert.deepEqual(view(natural, null).seats.a!.cards, cards('AS KS'));
  });

  it('reaching 21 keeps the turn, so it gives nothing away', () => {
    const state = play(dealt(['a', 'b'], 'TS TD 2S 5S 8D 3S 6C'), 'hit');
    assert.equal(handValue(state.seats.a!.cards), 21);
    assert.deepEqual(blackjack.activePlayers(state), ['a']);
    assert.deepEqual(view(state, 'b').seats.a, { cards: [null, null, '6C'], status: 'in', score: 0 });
  });

  it('reveals every card when the game ends', () => {
    const seen = view(play(dealt(['a', 'b'], TABLE), 'stand', 'stand'), null);
    assert.deepEqual(seen.seats.a!.cards, cards('TS 9S'));
    assert.deepEqual(seen.dealer, cards('KS 7S'));
  });

  it('never contains the deck or the seed, even after the game', () => {
    const inProgress = dealt(['a', 'b'], TABLE);
    const keys = ['dealer', 'hand', 'hands', 'history', 'order', 'seats', 'turn'];
    for (const state of [inProgress, play(inProgress, 'stand', 'stand')]) {
      for (const viewer of ['a', 'b', null]) assert.deepEqual(Object.keys(view(state, viewer)).sort(), keys);
    }
  });
});
