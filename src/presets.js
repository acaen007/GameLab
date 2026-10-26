/*
 * Built-in experiment presets (also saved as presets/*.json by `npm run presets`).
 * Browser: window.NFPresets. Node: module.exports.
 */
(function (root, factory) {
  const api = factory(root.NFEngine || (typeof require === "function" ? require("./engine.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NFPresets = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (E) {
  "use strict";

  function player(kind, extra = {}) {
    const p = E.defaultPlayer(kind);
    for (const [k, v] of Object.entries(extra)) p[k] = typeof v === "object" && v && !Array.isArray(v) ? { ...p[k], ...v } : v;
    return p;
  }

  function preset(id, name, description, game, p1, p2, sim = {}) {
    return {
      id,
      experiment: {
        version: 1, name, description, game, players: [p1, p2],
        sim: { horizon: 500, repetitions: 50, seed: 2024, switchRound: 250, epsilon: 0.05, rollingWindow: 50, deployment: "configured", ...sim },
      },
    };
  }

  const eps = 0.05;
  const list = [
    preset("deterministic_vs_mixed_ucb1", "Deterministic vs mixed rewards — UCB1",
      "Player 1 runs UCB1 with reward-only feedback. Use Compare deployments to run the four player-2 deployments with common random numbers.",
      E.presetGame(eps), player("ucb1"), player("pure", { action: 0 })),
    preset("deterministic_vs_mixed_exp3_binarized", "Deterministic vs mixed rewards — EXP3, binarized",
      "EXP3 with the horizon-tuned γ and Bernoulli-binarized rewards against the independent S2/S3 mixture.",
      E.presetGame(eps), player("exp3", { binarize: true }), player("mixed", { mixture: [0, 0.5 + eps, 0.5 - eps] }), { horizon: 1000 }),
    preset("deterministic_vs_mixed_thompson", "Deterministic vs mixed rewards — Thompson sampling",
      "Beta-Bernoulli Thompson sampling with binarized rewards, so posterior updates are exact.",
      E.presetGame(eps), player("thompson", { binarize: true }), player("pure", { action: 0 })),
    preset("deterministic_vs_secret_pool", "Deterministic vs mixed rewards — secret pool",
      "Player 2 secretly picks always-S1 or the S2/S3 mixture at match start (50/50) and keeps it for the whole match. Contrast with the independently resampled mixture.",
      E.presetGame(eps), player("ucb1"),
      player("pool", { pool: { strategies: [[1, 0, 0], [0, 0.5 + eps, 0.5 - eps]], weights: [0.5, 0.5] } })),
    preset("rps_hedge_vs_exp3", "Rock–paper–scissors — Hedge vs EXP3",
      "Both players learn. Hedge uses full information; EXP3 uses reward-only feedback. Payoffs in [−1, 1] are normalized affinely to [0, 1].",
      { rows: ["Rock", "Paper", "Scissors"], cols: ["Rock", "Paper", "Scissors"], payoff: [[0, -1, 1], [1, 0, -1], [-1, 1, 0]] },
      player("hedge", { feedback: "full-information" }), player("exp3", { seed: 7 }), { horizon: 2000, repetitions: 30 }),
    preset("biased_rps_minimax", "Biased rock–paper–scissors — UCB1 vs minimax",
      "An asymmetric RPS variant. Player 2 plays its LP minimax strategy, so player 1 cannot earn more than the game value in expectation.",
      { rows: ["Rock", "Paper", "Scissors"], cols: ["Rock", "Paper", "Scissors"], payoff: [[0, -2, 1], [2, 0, -1], [-1, 1, 0]] },
      player("ucb1"), player("minimax"), { horizon: 1000, repetitions: 30 }),
    preset("matching_pennies_thompson", "Matching pennies — Thompson vs uniform",
      "A 2×2 game whose value is 0. Thompson sampling on raw (non-binarized) normalized rewards against a uniform opponent.",
      { rows: ["Heads", "Tails"], cols: ["Heads", "Tails"], payoff: [[1, -1], [-1, 1]] },
      player("thompson"), player("uniform")),
  ];

  return { list, byId: (id) => list.find((p) => p.id === id) };
});
