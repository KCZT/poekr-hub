'use strict';
/**
 * A room is one pot of money that can pass through several games in a night:
 * hold'em, a blackjack intermission, then back to hold'em. Each stretch is a
 * "segment" so results can be attributed per game without splitting the cash.
 */
const GAMES = {
  texas_holdem: {
    name: "Texas hold'em", short: 'Hold’em', kind: 'poker',
    blurb: 'Two cards down, five in the middle.',
    fields: [
      { key: 'smallBlind', label: 'Small blind', type: 'money', default: 0.25 },
      { key: 'bigBlind', label: 'Big blind', type: 'money', default: 0.5 },
      { key: 'ante', label: 'Ante', type: 'money', default: 0 }
    ]
  },
  omaha: {
    name: 'Pot limit Omaha', short: 'PLO', kind: 'poker',
    blurb: 'Four cards down, use exactly two.',
    fields: [
      { key: 'smallBlind', label: 'Small blind', type: 'money', default: 0.25 },
      { key: 'bigBlind', label: 'Big blind', type: 'money', default: 0.5 }
    ]
  },
  seven_stud: {
    name: 'Seven card stud', short: 'Stud', kind: 'poker',
    blurb: 'No community cards, plenty of memory.',
    fields: [
      { key: 'ante', label: 'Ante', type: 'money', default: 0.25 },
      { key: 'bringIn', label: 'Bring-in', type: 'money', default: 0.5 }
    ]
  },
  short_deck: {
    name: 'Short deck', short: 'Short', kind: 'poker',
    blurb: 'Deuces through fives removed. Flushes beat full houses.',
    fields: [
      { key: 'ante', label: 'Ante', type: 'money', default: 0.5 },
      { key: 'button', label: 'Button blind', type: 'money', default: 1 }
    ]
  },
  blackjack: {
    name: 'Blackjack', short: 'Blackjack', kind: 'house',
    blurb: 'One player deals, everyone else plays against the deal.',
    fields: [
      { key: 'tableMin', label: 'Table minimum', type: 'money', default: 1 },
      { key: 'tableMax', label: 'Table maximum', type: 'money', default: 25 },
      { key: 'blackjackPays', label: 'Blackjack pays', type: 'text', default: '3:2' },
      { key: 'dealerId', label: 'Dealer', type: 'player', default: null }
    ]
  },
  dealers_choice: {
    name: "Dealer's choice", short: 'Choice', kind: 'poker',
    blurb: 'Whoever deals calls the game.',
    fields: [
      { key: 'smallBlind', label: 'Small blind', type: 'money', default: 0.25 },
      { key: 'bigBlind', label: 'Big blind', type: 'money', default: 0.5 }
    ]
  },
};

function defaults(gameId) {
  const g = GAMES[gameId];
  if (!g) return {};
  const out = {};
  for (const f of g.fields) out[f.key] = f.default;
  return out;
}

function isGame(gameId) { return Object.prototype.hasOwnProperty.call(GAMES, gameId); }

function label(gameId) { return GAMES[gameId]?.name || gameId; }

module.exports = { GAMES, defaults, isGame, label };
