/*
 * Kuhn and Leduc poker with simple behaviour strategies, evaluated exactly.
 * Pure computation, no DOM. Browser: window.NFPoker. Node: module.exports.
 *
 * A strategy gives, for every betting round and hand class, the probability to
 * - bet   when no bet is pending (otherwise check),
 * - raise when facing a bet while a raise is still allowed (Leduc only),
 * - call  when facing a bet and not raising (otherwise fold).
 * Evaluation enumerates every deal and every action path, so results are exact.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NFPoker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RANKS = ["J", "Q", "K"];
  const cls = (key, label) => ({ key, label });

  const GAMES = {
    kuhn: {
      key: "kuhn",
      name: "Kuhn poker",
      rules: "Cards J < Q < K, one dealt to each player. Both ante 1, then a single betting round with bet size 1 and at most one bet. Player 1 acts first; at showdown the higher card wins.",
      deck: [0, 1, 2],
      board: false,
      params: ["bet", "call"],
      rounds: [{ label: "Private card", bet: 1, maxBets: 1, classes: [cls("K", "K"), cls("Q", "Q"), cls("J", "J")] }],
      outcomes: [-2, -1, 1, 2],
    },
    leduc: {
      key: "leduc",
      name: "Leduc poker",
      rules: "Deck J J Q Q K K. Both ante 1 and receive one private card. Round 1 has bet size 2; then a public board card is dealt and round 2 has bet size 4. Each round allows a bet and one raise, and Player 1 acts first. A pair with the board wins, otherwise the higher card; equal cards split the pot.",
      deck: [0, 0, 1, 1, 2, 2],
      board: true,
      params: ["bet", "raise", "call"],
      rounds: [
        { label: "Round 1 · private card", bet: 2, maxBets: 2, classes: [cls("K", "K"), cls("Q", "Q"), cls("J", "J")] },
        { label: "Round 2 · with the board card", bet: 4, maxBets: 2, classes: [cls("pair", "Pair"), cls("K", "K high"), cls("Q", "Q high"), cls("J", "J high")] },
      ],
      outcomes: [-13, -11, -9, -7, -5, -3, -1, 0, 1, 3, 5, 7, 9, 11, 13],
    },
  };

  const PARAM_LABELS = { bet: "Bet", raise: "Raise", call: "Call" };

  /** What each parameter means for this game and player, in plain words. */
  function paramHelp(game, player) {
    if (game === "kuhn") {
      return player === 0
        ? { bet: "Chance to open with a bet (otherwise check).", call: "After checking, chance to call Player 2's bet (otherwise fold)." }
        : { bet: "After Player 1 checks, chance to bet (otherwise check).", call: "When Player 1 bets, chance to call (otherwise fold)." };
    }
    return {
      bet: "When no bet is pending, chance to bet (otherwise check).",
      raise: "When facing a bet and a raise is still allowed, chance to raise.",
      call: "When facing a bet and not raising, chance to call (otherwise fold).",
    };
  }

  // ---------------------------------------------------------- templates ----
  const fill = (game, fn) => GAMES[game].rounds.map((round, r) => {
    const out = {};
    round.classes.forEach((c, k) => {
      const v = fn(c.key, k, r);
      out[c.key] = Object.fromEntries(GAMES[game].params.map((p) => [p, v[p]]));
    });
    return out;
  });

  const ALPHA_MAX = 1 / 3;

  /**
   * Kuhn equilibrium. Player 1's equilibria are a family indexed by the J bluff frequency
   * α ∈ [0, 1/3]: bet J with α, bet K with 3α, call with Q with α + 1/3. Player 2's is unique.
   */
  function kuhnNash(player, alpha = ALPHA_MAX) {
    if (player === 1) return [{ K: { bet: 1, call: 1 }, Q: { bet: 0, call: 1 / 3 }, J: { bet: 1 / 3, call: 0 } }];
    const a = Math.min(ALPHA_MAX, Math.max(0, alpha));
    return [{ K: { bet: 3 * a, call: 1 }, Q: { bet: 0, call: a + 1 / 3 }, J: { bet: a, call: 0 } }];
  }

  /** α when these Kuhn probabilities are a Player 1 equilibrium, otherwise null. */
  function nashAlpha(probs) {
    const x = probs && probs[0];
    if (!x || !x.K || !x.Q || !x.J || !(x.J.bet >= 0 && x.J.bet <= ALPHA_MAX + 1e-9)) return null;
    const ref = kuhnNash(0, x.J.bet)[0];
    for (const c of RANKS) for (const p of ["bet", "call"]) if (!(Math.abs(x[c][p] - ref[c][p]) <= 1e-6)) return null;
    return Math.min(ALPHA_MAX, x.J.bet);
  }

  const alphaText = (a) => (Math.abs(a - 1 / 3) < 1e-9 ? "1/3" : Math.abs(a - 1 / 6) < 1e-9 ? "1/6" : String(+a.toFixed(3)));
  const nashName = (a) => `Nash (α = ${alphaText(a)})`;

  const TEMPLATES = [
    {
      key: "nash", label: "Nash equilibrium", games: ["kuhn"],
      note: (game, player) => (player === 0 ? "Bluffs J with chance α and bets K with 3α; α is adjustable from 0 to 1/3. Player 1's value is −1/18." : "Player 2's unique equilibrium. Player 1's value is −1/18."),
      make: (game, player) => kuhnNash(player),
    },
    {
      key: "uniform", label: "Uniform random",
      note: () => "Every legal action is equally likely.",
      make: (game) => fill(game, () => ({ bet: 0.5, raise: 1 / 3, call: 0.5 })),
    },
    {
      key: "tight", label: "Tight",
      note: (game) => (game === "kuhn" ? "Bets and calls only with a K." : "Bets, raises and calls only with a K in round 1 and a pair in round 2."),
      make: (game) => fill(game, (key, k) => { const v = k === 0 ? 1 : 0; return { bet: v, raise: v, call: v }; }),
    },
    {
      key: "station", label: "Calling station",
      note: (game) => (game === "kuhn" ? "Never bets; always calls." : "Never bets or raises; always calls."),
      make: (game) => fill(game, () => ({ bet: 0, raise: 0, call: 1 })),
    },
    {
      key: "maniac", label: "Maniac",
      note: (game) => (game === "kuhn" ? "Always bets and calls." : "Always bets, raises and calls."),
      make: (game) => fill(game, () => ({ bet: 1, raise: 1, call: 1 })),
    },
  ];

  const templatesFor = (game) => TEMPLATES.filter((t) => !t.games || t.games.includes(game));

  function makeStrategy(game, templateKey, player) {
    const t = TEMPLATES.find((x) => x.key === templateKey && (!x.games || x.games.includes(game)));
    if (!t) throw new Error(`Unknown template ${templateKey} for ${game}`);
    if (t.key === "nash" && player === 0) return { name: nashName(ALPHA_MAX), probs: t.make(game, player), alpha: ALPHA_MAX };
    return { name: t.label, probs: t.make(game, player) };
  }

  /** Fill gaps and clamp a stored strategy so it is always playable. */
  function normalizeStrategy(game, raw, player = 0) {
    const g = GAMES[game];
    const base = makeStrategy(game, "uniform", 0).probs;
    const probs = g.rounds.map((round, r) => {
      const out = {};
      for (const c of round.classes) {
        out[c.key] = {};
        for (const p of g.params) {
          const v = raw && raw.probs && raw.probs[r] && raw.probs[r][c.key] ? Number(raw.probs[r][c.key][p]) : NaN;
          out[c.key][p] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : base[r][c.key][p];
        }
      }
      return out;
    });
    const name = raw && typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : "Strategy";
    if (game !== "kuhn" || player !== 0) return { name, probs };
    const stored = raw && typeof raw.alpha === "number" ? raw.alpha : NaN;
    const alpha = stored >= 0 && stored <= ALPHA_MAX + 1e-9 ? Math.min(ALPHA_MAX, stored) : nashAlpha(probs);
    return alpha === null ? { name, probs } : { name, probs, alpha };
  }

  // --------------------------------------------------------- evaluation ----
  const dealCache = {};
  function deals(game) {
    if (dealCache[game]) return dealCache[game];
    const g = GAMES[game], n = g.deck.length, out = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (!g.board) { out.push({ cards: [g.deck[i], g.deck[j]], board: null }); continue; }
        for (let k = 0; k < n; k++) if (k !== i && k !== j) out.push({ cards: [g.deck[i], g.deck[j]], board: g.deck[k] });
      }
    }
    dealCache[game] = out;
    return out;
  }

  const classOf = (game, r, card, board) => (r === 1 && card === board ? "pair" : RANKS[card]);

  /**
   * Exact distribution of Player 1's payoff for one hand of strategies[0] vs strategies[1].
   * Returns {mean, sd, outcomes:[{value, prob}], win, tie, lose, showdown, folds:[p1, p2], deals}.
   */
  function evaluate(game, strategies) {
    const g = GAMES[game];
    const mass = new Map(g.outcomes.map((v) => [v, 0]));
    const add = (v, q) => mass.set(v, (mass.get(v) || 0) + q);
    let showdown = 0;
    const folds = [0, 0];
    const all = deals(game);
    const pDeal = 1 / all.length;

    for (const { cards, board } of all) {
      const strength = cards.map((c) => (c === board ? 10 : 0) + c);

      const finish = (r, c, q) => {
        if (r + 1 < g.rounds.length) { playRound(r + 1, c, q); return; }
        showdown += q;
        add(strength[0] > strength[1] ? c[1] : strength[0] < strength[1] ? -c[0] : 0, q);
      };

      const playRound = (r, contrib, q0) => {
        const round = g.rounds[r];
        const s = [0, 1].map((i) => strategies[i].probs[r][classOf(game, r, cards[i], board)]);
        const raiseBy = (c, actor) => { const n = c.slice(); n[actor] = c[1 - actor] + round.bet; return n; };
        // `checked`: the previous player checked, so a second check ends the round.
        const node = (actor, bets, checked, c, q) => {
          const x = s[actor];
          if (c[actor] === c[1 - actor]) {
            if (x.bet < 1) { if (checked) finish(r, c, q * (1 - x.bet)); else node(1 - actor, bets, true, c, q * (1 - x.bet)); }
            if (x.bet > 0) node(1 - actor, bets + 1, false, raiseBy(c, actor), q * x.bet);
            return;
          }
          const raise = bets < round.maxBets ? (x.raise || 0) : 0;
          if (raise > 0) node(1 - actor, bets + 1, false, raiseBy(c, actor), q * raise);
          const call = (1 - raise) * x.call, fold = (1 - raise) * (1 - x.call);
          if (call > 0) { const n = c.slice(); n[actor] = c[1 - actor]; finish(r, n, q * call); }
          if (fold > 0) { folds[actor] += q * fold; add(actor === 0 ? -c[0] : c[1], q * fold); }
        };
        node(0, 0, false, contrib, q0);
      };

      playRound(0, [1, 1], pDeal);
    }

    const outcomes = [...mass.entries()].map(([value, prob]) => ({ value, prob })).sort((a, b) => a.value - b.value);
    let mean = 0, win = 0, tie = 0, lose = 0;
    for (const o of outcomes) {
      mean += o.value * o.prob;
      if (o.value > 0) win += o.prob; else if (o.value < 0) lose += o.prob; else tie += o.prob;
    }
    const variance = outcomes.reduce((acc, o) => acc + o.prob * (o.value - mean) ** 2, 0);
    return { mean, sd: Math.sqrt(Math.max(0, variance)), outcomes, win, tie, lose, showdown, folds, deals: all.length };
  }

  /** Expected payoff of Player 1 for every pair of the two portfolios. */
  function payoffMatrix(game, portfolios) {
    return portfolios[0].map((s1) => portfolios[1].map((s2) => evaluate(game, [s1, s2]).mean));
  }

  /**
   * Extensive-form tree of one hand of strategies[0] vs strategies[1], private deals grouped by rank.
   * Every node has {id, kind: "chance" | "decision" | "terminal", edge, p, reach, children}, where `p` is
   * the probability of the edge into the node and `reach` the product of probabilities from the root.
   * Decision nodes add {player, card, board}; terminals add {payoff (to Player 1), end, folder}.
   */
  function gameTree(game, strategies) {
    const g = GAMES[game], n = g.deck.length;
    const count = RANKS.map((_, r) => g.deck.filter((c) => c === r).length);
    const terminal = (id, edge, p, reach, payoff, end, folder) => ({ id, kind: "terminal", edge, p, reach, payoff, end, folder, children: [] });
    const raiseBy = (c, actor, size) => { const x = c.slice(); x[actor] = c[1 - actor] + size; return x; };

    function decision(id, edge, p, reach, deal, r, actor, bets, checked, c) {
      const { cards, board } = deal, round = g.rounds[r];
      const x = strategies[actor].probs[r][classOf(game, r, cards[actor], board)];
      const node = { id, kind: "decision", edge, p, reach, player: actor, card: RANKS[cards[actor]], board: board === null ? null : RANKS[board], children: [] };
      const act = (action) => ({ type: "action", action, player: actor });
      const next = (key, action, q, b, chk, cc) => decision(id + key, act(action), q, reach * q, deal, r, 1 - actor, b, chk, cc);
      const endRound = (key, action, q, cc) => {
        if (r + 1 < g.rounds.length) return boardNode(id + key, act(action), q, reach * q, cards, cc);
        const s = cards.map((v) => (v === board ? 10 : 0) + v);
        return terminal(id + key, act(action), q, reach * q, s[0] > s[1] ? cc[1] : s[0] < s[1] ? -cc[0] : 0, "showdown", null);
      };
      if (c[actor] === c[1 - actor]) {
        node.children.push(checked ? endRound("k", "Check", 1 - x.bet, c) : next("k", "Check", 1 - x.bet, bets, true, c));
        node.children.push(next("b", "Bet", x.bet, bets + 1, false, raiseBy(c, actor, round.bet)));
      } else {
        const canRaise = bets < round.maxBets, raise = canRaise ? x.raise || 0 : 0;
        const fold = (1 - raise) * (1 - x.call), called = c.slice();
        called[actor] = c[1 - actor];
        node.children.push(terminal(`${id}f`, act("Fold"), fold, reach * fold, actor === 0 ? -c[0] : c[1], "fold", actor));
        node.children.push(endRound("c", "Call", (1 - raise) * x.call, called));
        if (canRaise) node.children.push(next("r", "Raise", raise, bets + 1, false, raiseBy(c, actor, round.bet)));
      }
      return node;
    }

    function boardNode(id, edge, p, reach, cards, c) {
      const node = { id, kind: "chance", edge, p, reach, children: [] };
      RANKS.forEach((_, b) => {
        const left = count[b] - (cards[0] === b ? 1 : 0) - (cards[1] === b ? 1 : 0);
        if (left > 0) node.children.push(decision(`${id}|${RANKS[b]}`, { type: "board", card: RANKS[b] }, left / (n - 2), (reach * left) / (n - 2), { cards, board: b }, 1, 0, 0, false, c));
      });
      return node;
    }

    const root = { id: "", kind: "chance", edge: null, p: 1, reach: 1, children: [] };
    RANKS.forEach((_, a) => RANKS.forEach((__, b) => {
      const ways = count[a] * (count[b] - (a === b ? 1 : 0));
      if (ways > 0) root.children.push(decision(RANKS[a] + RANKS[b], { type: "deal", cards: [RANKS[a], RANKS[b]] }, ways / (n * (n - 1)), ways / (n * (n - 1)), { cards: [a, b], board: null }, 0, 0, 0, false, [1, 1]));
    }));
    return root;
  }

  return {
    RANKS, GAMES, PARAM_LABELS, TEMPLATES, ALPHA_MAX, paramHelp, templatesFor, makeStrategy, normalizeStrategy,
    kuhnNash, nashAlpha, alphaText, nashName, deals, evaluate, payoffMatrix, gameTree,
  };
});
