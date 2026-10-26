/*
 * Normal-form learning engine. Pure computation, no DOM access.
 * Browser: exposes window.NFEngine. Node: module.exports.
 *
 * Conventions
 * - Player 1 chooses rows, player 2 columns. Games are zero-sum: U1 = A, U2 = -A^T.
 * - Rounds are 1-based. Each round both players choose before either is updated.
 * - Learners only ever receive an "observation" object; counterfactual payoffs for
 *   regret are computed by the evaluator inside createMatch and never handed over
 *   unless the player is configured for full-information feedback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NFEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PROB_TOL = 1e-6;
  const TIE_TOL = 1e-12;

  class ConfigError extends Error {
    constructor(errors) {
      super(errors.join("\n"));
      this.name = "ConfigError";
      this.errors = errors;
    }
  }

  // ---------------------------------------------------------------- RNG ----
  // Streams are keyed by strings such as "choice/seed/repetition/player", so every
  // source of randomness is independent and reproducible (cyrb128 seeding + sfc32).
  function hash128(key) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < key.length; i++) {
      const k = key.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  class Stream {
    constructor(...parts) {
      [this.a, this.b, this.c, this.d] = hash128(parts.join("/"));
      for (let i = 0; i < 16; i++) this.uint32();
    }
    uint32() {
      let { a, b, c, d } = this;
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      this.a = a; this.b = b; this.c = c; this.d = d;
      return t >>> 0;
    }
    next() { return this.uint32() / 4294967296; }
    normal() {
      let u = 0;
      while (u === 0) u = this.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
    }
    gamma(shape) {
      if (shape < 1) {
        let u = 0;
        while (u === 0) u = this.next();
        return this.gamma(shape + 1) * Math.pow(u, 1 / shape);
      }
      const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
      for (;;) {
        let x, v;
        do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
        v = v * v * v;
        const u = this.next();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
      }
    }
    beta(a, b) {
      const x = this.gamma(a), y = this.gamma(b);
      return x / (x + y);
    }
  }

  function sampleIndex(p, u) {
    let acc = 0, last = -1;
    for (let i = 0; i < p.length; i++) {
      if (!(p[i] > 0)) continue;
      acc += p[i];
      last = i;
      if (u < acc) return i;
    }
    return last;
  }

  // ------------------------------------------------------------ helpers ----
  const sum = (xs) => { let s = 0; for (const x of xs) s += x; return s; };
  const argmaxValue = (xs) => { let m = -Infinity; for (const x of xs) if (x > m) m = x; return m; };
  const oneHot = (k, K) => { const p = new Float64Array(K); p[k] = 1; return p; };
  const uniform = (K) => new Float64Array(K).fill(1 / K);
  const matVec = (M, v) => M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
  const vecMat = (v, M) => M[0].map((_, j) => M.reduce((s, row, i) => s + v[i] * row[j], 0));
  const approxEqualVec = (a, b, tol = 1e-12) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

  function softmax(logW) {
    const m = argmaxValue(logW);
    const w = Array.from(logW, (x) => Math.exp(x - m));
    const s = sum(w);
    return Float64Array.from(w, (x) => x / s);
  }

  /** Validate a probability vector. Returns {errors, value} with value renormalized. */
  function checkMixture(values, K, label = "Mixture") {
    const errors = [];
    if (!Array.isArray(values) && !(values instanceof Float64Array)) return { errors: [`${label}: enter ${K} probabilities.`], value: null };
    if (values.length !== K) errors.push(`${label}: expected ${K} probabilities, got ${values.length}.`);
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (typeof x !== "number" || !Number.isFinite(x)) errors.push(`${label}: entry ${i + 1} is not a number.`);
      else if (x < -1e-12) errors.push(`${label}: entry ${i + 1} is negative.`);
    }
    if (!errors.length) {
      const s = sum(values);
      if (Math.abs(s - 1) > PROB_TOL) errors.push(`${label}: probabilities sum to ${+s.toFixed(6)}, not 1.`);
    }
    if (errors.length) return { errors, value: null };
    const clipped = Array.from(values, (x) => Math.max(0, x));
    const s = sum(clipped);
    return { errors, value: Float64Array.from(clipped, (x) => x / s) };
  }

  // ----------------------------------------------------- game utilities ----
  function playerTable(game, i) {
    const A = game.payoff;
    if (i === 0) return A.map((row) => row.slice());
    return A[0].map((_, j) => A.map((row) => 0 - row[j]));
  }

  function validateGame(game) {
    const errors = [];
    if (!game || !Array.isArray(game.rows) || !Array.isArray(game.cols) || !Array.isArray(game.payoff)) return ["Game: missing rows, columns or payoff matrix."];
    const { rows, cols, payoff } = game;
    if (rows.length < 1 || cols.length < 1) errors.push("Game: needs at least one row and one column.");
    if (rows.length > 20 || cols.length > 20) errors.push("Game: at most 20 actions per player.");
    for (const [names, who] of [[rows, "Row"], [cols, "Column"]]) {
      names.forEach((n, k) => { if (typeof n !== "string" || !n.trim()) errors.push(`Game: ${who} ${k + 1} needs a name.`); });
      const trimmed = names.map((n) => String(n).trim());
      if (new Set(trimmed).size !== trimmed.length) errors.push(`Game: ${who.toLowerCase()} action names must be unique.`);
    }
    if (payoff.length !== rows.length || payoff.some((r) => !Array.isArray(r) || r.length !== cols.length)) {
      errors.push("Game: payoff matrix dimensions do not match the action lists.");
      return errors;
    }
    payoff.forEach((r, i) => r.forEach((x, j) => {
      if (typeof x !== "number" || !Number.isFinite(x)) errors.push(`Game: payoff (${rows[i]}, ${cols[j]}) is not a number.`);
    }));
    return errors;
  }

  // ----------------------------------------------------- linear program ----
  /**
   * Zero-sum solution by the simplex method (Bland's rule, so no cycling).
   * Shift A to B = A + s > 0 and solve  max 1'y  s.t. B y <= 1, y >= 0.
   * Then value(B) = 1/z, column minimax q = y/z, row minimax p = dual/z.
   */
  function solveZeroSum(A) {
    const m = A.length, n = A[0].length;
    let lo = Infinity;
    for (const row of A) for (const x of row) lo = Math.min(lo, x);
    const shift = 1 - lo;
    const cols = n + m;
    const T = [];
    for (let i = 0; i < m; i++) {
      const r = new Float64Array(cols + 1);
      for (let j = 0; j < n; j++) r[j] = A[i][j] + shift;
      r[n + i] = 1;
      r[cols] = 1;
      T.push(r);
    }
    const obj = new Float64Array(cols + 1);
    for (let j = 0; j < n; j++) obj[j] = -1;
    const basis = Array.from({ length: m }, (_, i) => n + i);
    const eps = 1e-12;
    for (let iter = 0; iter < 10000; iter++) {
      let enter = -1;
      for (let j = 0; j < cols; j++) if (obj[j] < -eps) { enter = j; break; }
      if (enter < 0) break;
      let leave = -1, best = Infinity;
      for (let i = 0; i < m; i++) {
        if (T[i][enter] > eps) {
          const ratio = T[i][cols] / T[i][enter];
          if (ratio < best - eps || (Math.abs(ratio - best) <= eps && basis[i] < basis[leave])) { best = ratio; leave = i; }
        }
      }
      if (leave < 0) throw new Error("Linear program is unbounded (should not happen for a finite game).");
      const pr = T[leave], pv = pr[enter];
      for (let j = 0; j <= cols; j++) pr[j] /= pv;
      for (let i = 0; i < m; i++) {
        if (i === leave) continue;
        const f = T[i][enter];
        if (f !== 0) for (let j = 0; j <= cols; j++) T[i][j] -= f * pr[j];
      }
      const f = obj[enter];
      for (let j = 0; j <= cols; j++) obj[j] -= f * pr[j];
      basis[leave] = enter;
    }
    const y = new Float64Array(n);
    basis.forEach((b, i) => { if (b < n) y[b] = T[i][cols]; });
    const z = obj[cols];
    const x = Float64Array.from({ length: m }, (_, i) => Math.max(0, obj[n + i]));
    const clean = (v) => { const c = Array.from(v, (t) => (t < 1e-12 ? 0 : t)); const s = sum(c); return Float64Array.from(c, (t) => t / s); };
    return { value: 1 / z - shift, row: clean(x), col: clean(y) };
  }

  // -------------------------------------------------------- normalizing ----
  /**
   * Fixed affine reward normalization for one player's payoff table, chosen once
   * from the whole table: identity if every payoff already lies in [0,1],
   * otherwise r~ = (r - min) / (max - min). A constant table outside [0,1] maps to 0.5.
   */
  function makeNormalizer(table) {
    let lo = Infinity, hi = -Infinity;
    for (const row of table) for (const x of row) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    if (lo >= 0 && hi <= 1) return { kind: "identity", lo, hi, apply: (r) => r, describe: "r~ = r (payoffs already in [0, 1])" };
    if (hi === lo) return { kind: "constant", lo, hi, apply: () => 0.5, describe: `r~ = 0.5 (all payoffs equal ${lo})` };
    const span = hi - lo;
    return {
      kind: "affine", lo, hi,
      apply: (r) => Math.min(1, Math.max(0, (r - lo) / span)),
      describe: `r~ = (r - (${fmt(lo)})) / ${fmt(span)}`,
    };
  }

  function fmt(x) { return Number.isInteger(x) ? String(x) : String(+x.toPrecision(6)); }

  // ------------------------------------------------------------- preset ----
  const ARMS = {
    S1: { label: "Always S1", short: "S1" },
    mixture: { label: "Independent S2/S3 mix (0.5+ε / 0.5−ε)", short: "Mix" },
    mix_then_S1: { label: "Mix for first N rounds, then S1", short: "Mix→S1" },
    S1_then_mix: { label: "S1 for first N rounds, then mix", short: "S1→Mix" },
  };
  const ARM_KEYS = Object.keys(ARMS);

  function presetGame(eps = 0.05) {
    return { rows: ["A", "B"], cols: ["S1", "S2", "S3"], payoff: [[0.5 + eps, 1, 0], [0.5 - eps, 0, 1]] };
  }

  function isPresetGame(game, eps) {
    const p = presetGame(eps);
    return game.payoff.length === 2 && game.payoff.every((r) => r.length === 3)
      && game.payoff.every((r, i) => r.every((x, j) => Math.abs(x - p.payoff[i][j]) <= 1e-12));
  }

  /** Player 2's mixture in round t (1-based) under a preset deployment. */
  function armMixture(arm, t, eps, switchRound) {
    const pure = Float64Array.of(1, 0, 0);
    const mix = Float64Array.of(0, 0.5 + eps, 0.5 - eps);
    switch (arm) {
      case "S1": return pure;
      case "mixture": return mix;
      case "mix_then_S1": return t <= switchRound ? mix : pure;
      case "S1_then_mix": return t <= switchRound ? pure : mix;
      default: throw new Error(`Unknown deployment ${arm}`);
    }
  }

  function armPhases(arm, T, eps, N) {
    if (arm === "S1" || arm === "mixture") return [{ from: 1, to: T, mixture: armMixture(arm, 1, eps, N) }];
    const phases = [];
    if (N >= 1) phases.push({ from: 1, to: Math.min(N, T), mixture: armMixture(arm, 1, eps, N) });
    if (N < T) phases.push({ from: N + 1, to: T, mixture: armMixture(arm, N + 1, eps, N) });
    return phases;
  }

  // ------------------------------------------------------------ players ----
  const KINDS = {
    pure: { label: "Fixed pure action", group: "Fixed strategies", fixed: true, description: "Plays the same action every round." },
    mixed: { label: "Fixed mixed strategy (resampled every round)", group: "Fixed strategies", fixed: true, description: "Draws an action independently from the same mixture every round." },
    uniform: { label: "Uniform random", group: "Fixed strategies", fixed: true, description: "Every action with equal probability, independently every round." },
    pool: { label: "Secret pool (one strategy drawn at match start)", group: "Fixed strategies", fixed: true, description: "At the start of each match one strategy is drawn secretly from the pool and kept for the whole match." },
    minimax: { label: "Minimax strategy (LP)", group: "Fixed strategies", fixed: true, description: "Plays this player's equilibrium mixture from the linear program." },
    ucb1: { label: "UCB1", group: "Learning algorithms", description: "Bandit: tries each action once, then picks the highest mean + sqrt(c ln t / n). Reward-only feedback suffices." },
    ucbv: { label: "UCB-V (variance-aware UCB)", group: "Learning algorithms", description: "Bandit: tries each action once, then picks the highest mean + √(2 V ζ ln t / n) + 3c ζ ln t / n, where V is the action's empirical reward variance (Audibert, Munos & Szepesvári, 2009). Reward-only feedback suffices." },
    exp3: { label: "EXP3", group: "Learning algorithms", description: "Adversarial bandit with explicit exploration γ and importance-weighted updates. Reward-only feedback suffices." },
    hedge: { label: "Hedge (multiplicative weights)", group: "Learning algorithms", requiresFull: true, description: "Updates every action with its counterfactual reward. Requires full-information feedback." },
    thompson: { label: "Thompson sampling (Beta-Bernoulli)", group: "Learning algorithms", description: "Samples from Beta posteriors and plays the argmax. Exact Beta-Bernoulli updates when rewards are binarized." },
  };

  function defaultPlayer(kind = "ucb1") {
    return {
      kind,
      action: 0,
      mixture: [],
      pool: { strategies: [], weights: [] },
      feedback: "reward-only",
      binarize: false,
      seed: null,
      ucb: { c: 2, initOrder: "random" },
      ucbv: { zeta: 1.2, c: 1, initOrder: "random" },
      exp3: { gamma: null, initialWeights: null },
      hedge: { eta: null, initialWeights: null },
      thompson: { alpha: 1, beta: 1 },
    };
  }

  const defaultExp3Gamma = (K, T) => Math.min(1, Math.sqrt((K * Math.log(Math.max(K, 2))) / ((Math.E - 1) * T)));
  const defaultHedgeEta = (K, T) => Math.sqrt((8 * Math.log(Math.max(K, 2))) / T);

  function validatePlayer(cfg, K, label) {
    const errors = [];
    const e = (msg) => errors.push(`${label}: ${msg}`);
    if (!cfg || !KINDS[cfg.kind]) return [`${label}: unknown strategy "${cfg && cfg.kind}".`];
    const meta = KINDS[cfg.kind];
    if (!["reward-only", "full-information"].includes(cfg.feedback)) e("feedback must be reward-only or full-information.");
    if (meta.requiresFull && cfg.feedback !== "full-information") {
      e("Hedge needs full-information feedback because it updates every action with its counterfactual reward. Switch feedback to full information, or use EXP3/UCB1 for reward-only play.");
    }
    if (cfg.seed !== null && cfg.seed !== undefined && !Number.isInteger(cfg.seed)) e("learner seed must be an integer or blank.");
    switch (cfg.kind) {
      case "pure":
        if (!Number.isInteger(cfg.action) || cfg.action < 0 || cfg.action >= K) e("choose an action that exists in the matrix.");
        break;
      case "mixed":
        checkMixture(cfg.mixture, K, `${label} mixed strategy`).errors.forEach((m) => errors.push(m));
        break;
      case "pool": {
        const s = cfg.pool && cfg.pool.strategies, w = cfg.pool && cfg.pool.weights;
        if (!Array.isArray(s) || !s.length) { e("the strategy pool needs at least one strategy."); break; }
        s.forEach((m, k) => checkMixture(m, K, `${label} pool strategy ${k + 1}`).errors.forEach((x) => errors.push(x)));
        checkMixture(w, s.length, `${label} pool selection weights`).errors.forEach((x) => errors.push(x));
        break;
      }
      case "ucb1":
        if (!(Number.isFinite(cfg.ucb.c) && cfg.ucb.c >= 0)) e("UCB exploration coefficient c must be ≥ 0.");
        if (!["random", "sequential"].includes(cfg.ucb.initOrder)) e("UCB initialization order must be random or sequential.");
        break;
      case "ucbv":
        if (!(Number.isFinite(cfg.ucbv.zeta) && cfg.ucbv.zeta > 0)) e("UCB-V exploration ζ must be > 0.");
        if (!(Number.isFinite(cfg.ucbv.c) && cfg.ucbv.c >= 0)) e("UCB-V constant c must be ≥ 0.");
        if (!["random", "sequential"].includes(cfg.ucbv.initOrder)) e("UCB-V initialization order must be random or sequential.");
        break;
      case "exp3":
        if (cfg.exp3.gamma !== null && !(cfg.exp3.gamma > 0 && cfg.exp3.gamma <= 1)) e("EXP3 exploration γ must be in (0, 1], or blank for the horizon default.");
        checkWeights(cfg.exp3.initialWeights, K, e);
        break;
      case "hedge":
        if (cfg.hedge.eta !== null && !(Number.isFinite(cfg.hedge.eta) && cfg.hedge.eta > 0)) e("Hedge learning rate η must be > 0, or blank for the horizon default.");
        checkWeights(cfg.hedge.initialWeights, K, e);
        break;
      case "thompson":
        if (!(cfg.thompson.alpha > 0 && Number.isFinite(cfg.thompson.alpha))) e("Beta prior α must be > 0.");
        if (!(cfg.thompson.beta > 0 && Number.isFinite(cfg.thompson.beta))) e("Beta prior β must be > 0.");
        break;
      default:
    }
    return errors;
  }

  function checkWeights(w, K, e) {
    if (w === null || w === undefined) return;
    if (!Array.isArray(w) || w.length !== K || w.some((x) => !(Number.isFinite(x) && x > 0))) e(`initial weights must be ${K} positive numbers, or blank for uniform.`);
  }

  function validateExperiment(exp, opts = {}) {
    const errors = validateGame(exp.game);
    if (errors.length) return errors;
    const K = [exp.game.rows.length, exp.game.cols.length];
    const s = exp.sim;
    const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
    if (!intIn(s.horizon, 1, 1000000)) errors.push("Simulation: horizon T must be an integer between 1 and 1,000,000.");
    if (!intIn(s.repetitions, 1, 100000)) errors.push("Simulation: repetitions must be an integer ≥ 1.");
    if (!Number.isInteger(s.seed)) errors.push("Simulation: seed must be an integer.");
    if (!(s.epsilon > 0 && s.epsilon < 0.5)) errors.push("Preset: ε must satisfy 0 < ε < 0.5.");
    if (!intIn(s.rollingWindow, 1, 1000000)) errors.push("Simulation: rolling window must be a positive integer.");
    if (!intIn(s.switchRound, 0, Number.isInteger(s.horizon) ? s.horizon : 0)) errors.push("Simulation: switching round N must be an integer between 0 and T.");
    const arms = opts.arms || [opts.arm || s.deployment];
    for (const arm of arms) {
      if (arm !== "configured" && !ARMS[arm]) errors.push(`Simulation: unknown deployment "${arm}".`);
    }
    const usesArm = arms.some((a) => a !== "configured");
    if (usesArm && !isPresetGame(exp.game, s.epsilon)) {
      errors.push("Preset deployments need the deterministic-vs-mixed matrix with the current ε. Load the preset (or apply ε) first.");
    }
    errors.push(...validatePlayer(exp.players[0], K[0], "Player 1"));
    if (!usesArm || arms.includes("configured")) errors.push(...validatePlayer(exp.players[1], K[1], "Player 2"));
    return errors;
  }

  // ----------------------------------------------------------- learners ----
  class FixedStrategy {
    constructor(mixture, rng, extra = {}) {
      this.mixture = Float64Array.from(mixture);
      this.stationaryMixture = this.mixture;
      this.rng = rng;
      Object.assign(this, extra);
    }
    policy() { return Float64Array.from(this.mixture); }
    act(p) { return sampleIndex(p, this.rng.choice.next()); }
    update() {}
    estimates() { return null; }
    clone() { return Object.assign(Object.create(Object.getPrototypeOf(this)), this); }
  }

  class UCB1 {
    constructor(K, cfg, rng) {
      this.K = K; this.c = cfg.ucb.c; this.order = cfg.ucb.initOrder; this.rng = rng;
      this.n = new Float64Array(K); this.total = new Float64Array(K);
      this.estimateLabel = "Empirical mean of normalized feedback";
    }
    indices() {
      const t = sum(this.n);
      return Float64Array.from(this.n, (n, a) => (n === 0 ? Infinity : this.total[a] / n + Math.sqrt((this.c * Math.log(t)) / n)));
    }
    policy() {
      const p = new Float64Array(this.K);
      const unseen = [];
      this.n.forEach((n, a) => { if (n === 0) unseen.push(a); });
      if (unseen.length) {
        if (this.order === "sequential") p[unseen[0]] = 1;
        else unseen.forEach((a) => { p[a] = 1 / unseen.length; });
        return p;
      }
      const idx = this.indices();
      const best = argmaxValue(idx);
      const ties = [];
      idx.forEach((v, a) => { if (best - v <= TIE_TOL * Math.max(1, Math.abs(best))) ties.push(a); });
      ties.forEach((a) => { p[a] = 1 / ties.length; });
      return p;
    }
    act(p) { return sampleIndex(p, this.rng.choice.next()); }
    update(obs) { this.n[obs.action] += 1; this.total[obs.action] += obs.reward; }
    estimates() { return Float64Array.from(this.n, (n, a) => (n ? this.total[a] / n : NaN)); }
    parameters() { return [["c", this.c], ["initialization", this.order === "random" ? "each action once, random order" : "each action once, index order"]]; }
    clone() { const c = Object.assign(Object.create(UCB1.prototype), this); c.n = this.n.slice(); c.total = this.total.slice(); return c; }
  }

  /** UCB-V with E_t = ζ ln t and reward range b = 1 (learners see rewards in [0, 1]). */
  class UCBV extends UCB1 {
    constructor(K, cfg, rng) {
      super(K, { ucb: { c: 0, initOrder: cfg.ucbv.initOrder } }, rng);
      this.zeta = cfg.ucbv.zeta; this.cv = cfg.ucbv.c;
      this.sq = new Float64Array(K);
    }
    indices() {
      const explore = this.zeta * Math.log(sum(this.n));
      return Float64Array.from(this.n, (n, a) => {
        if (n === 0) return Infinity;
        const mean = this.total[a] / n, variance = Math.max(0, this.sq[a] / n - mean * mean);
        return mean + Math.sqrt((2 * variance * explore) / n) + (3 * this.cv * explore) / n;
      });
    }
    update(obs) { super.update(obs); this.sq[obs.action] += obs.reward * obs.reward; }
    parameters() {
      return [["ζ", this.zeta], ["c", this.cv], ["initialization", this.order === "random" ? "each action once, random order" : "each action once, index order"]];
    }
    clone() { const c = Object.assign(Object.create(UCBV.prototype), this); c.n = this.n.slice(); c.total = this.total.slice(); c.sq = this.sq.slice(); return c; }
  }

  class Exp3 {
    constructor(K, cfg, rng, horizon) {
      this.K = K; this.rng = rng;
      this.auto = cfg.exp3.gamma === null || cfg.exp3.gamma === undefined;
      this.gamma = this.auto ? defaultExp3Gamma(K, horizon) : cfg.exp3.gamma;
      this.horizon = horizon;
      this.logW = Float64Array.from(cfg.exp3.initialWeights || new Array(K).fill(1), Math.log);
      this.S = new Float64Array(K);
      this.estimateLabel = "Importance-weighted cumulative reward estimate";
    }
    policy() { const w = softmax(this.logW); return Float64Array.from(w, (x) => (1 - this.gamma) * x + this.gamma / this.K); }
    act(p) { this.played = p; return sampleIndex(p, this.rng.choice.next()); }
    update(obs) {
      const xhat = obs.reward / this.played[obs.action];
      this.S[obs.action] += xhat;
      this.logW[obs.action] += (this.gamma * xhat) / this.K;
    }
    estimates() { return this.S.slice(); }
    weights() { return softmax(this.logW); }
    parameters() { return [["γ", this.gamma, this.auto ? `auto: min(1, √(K ln K / ((e−1) T))), T = ${this.horizon}` : "manual"]]; }
    clone() { const c = Object.assign(Object.create(Exp3.prototype), this); c.logW = this.logW.slice(); c.S = this.S.slice(); return c; }
  }

  class Hedge {
    constructor(K, cfg, rng, horizon) {
      this.K = K; this.rng = rng;
      this.auto = cfg.hedge.eta === null || cfg.hedge.eta === undefined;
      this.eta = this.auto ? defaultHedgeEta(K, horizon) : cfg.hedge.eta;
      this.horizon = horizon;
      this.logW = Float64Array.from(cfg.hedge.initialWeights || new Array(K).fill(1), Math.log);
      this.S = new Float64Array(K);
      this.estimateLabel = "Cumulative normalized counterfactual reward";
    }
    policy() { return softmax(this.logW); }
    act(p) { return sampleIndex(p, this.rng.choice.next()); }
    update(obs) {
      if (!obs.counterfactual) throw new Error("Hedge received reward-only feedback; it requires full information.");
      for (let a = 0; a < this.K; a++) { this.logW[a] += this.eta * obs.counterfactual[a]; this.S[a] += obs.counterfactual[a]; }
    }
    estimates() { return this.S.slice(); }
    weights() { return softmax(this.logW); }
    parameters() { return [["η", this.eta, this.auto ? `auto: √(8 ln K / T), T = ${this.horizon}` : "manual"]]; }
    clone() { const c = Object.assign(Object.create(Hedge.prototype), this); c.logW = this.logW.slice(); c.S = this.S.slice(); return c; }
  }

  function logGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /** P(arm k has the largest Beta draw), by deterministic quadrature (used for display only). */
  function betaWinProbabilities(alpha, beta, grid = 400) {
    const K = alpha.length;
    if (K === 1) return Float64Array.of(1);
    let lo = 1, hi = 0;
    for (let k = 0; k < K; k++) {
      const a = alpha[k], b = beta[k], s = a + b;
      const mean = a / s, sd = Math.sqrt((a * b) / (s * s * (s + 1)));
      lo = Math.min(lo, mean - 12 * sd); hi = Math.max(hi, mean + 12 * sd);
    }
    lo = Math.max(0, lo); hi = Math.min(1, hi);
    const dx = (hi - lo) / grid;
    const mass = [];
    for (let k = 0; k < K; k++) {
      const a = alpha[k], b = beta[k];
      const lb = logGamma(a) + logGamma(b) - logGamma(a + b);
      const m = new Float64Array(grid);
      for (let g = 0; g < grid; g++) {
        const x = lo + (g + 0.5) * dx;
        m[g] = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lb);
      }
      const s = sum(m);
      for (let g = 0; g < grid; g++) m[g] = s > 0 ? m[g] / s : 1 / grid;
      mass.push(m);
    }
    const cum = new Float64Array(K), win = new Float64Array(K);
    for (let g = 0; g < grid; g++) {
      const F = Float64Array.from(cum, (c, k) => c + mass[k][g] / 2);
      for (let k = 0; k < K; k++) {
        let prod = mass[k][g];
        for (let j = 0; j < K; j++) if (j !== k) prod *= F[j];
        win[k] += prod;
      }
      for (let k = 0; k < K; k++) cum[k] += mass[k][g];
    }
    const s = sum(win);
    return Float64Array.from(win, (w) => w / s);
  }

  class Thompson {
    constructor(K, cfg, rng) {
      this.K = K; this.rng = rng;
      this.alpha = new Float64Array(K).fill(cfg.thompson.alpha);
      this.beta = new Float64Array(K).fill(cfg.thompson.beta);
      this.prior = [cfg.thompson.alpha, cfg.thompson.beta];
      this.estimateLabel = "Posterior mean α / (α + β)";
    }
    // Displayed probabilities are exact-in-distribution (quadrature); the action itself is a posterior draw.
    policy() { return betaWinProbabilities(this.alpha, this.beta); }
    act(p, t) {
      // A fresh per-round sub-stream keeps comparison arms aligned round by round.
      const s = new Stream(this.rng.thompsonKey, t);
      let best = -1, arg = 0;
      for (let a = 0; a < this.K; a++) { const x = s.beta(this.alpha[a], this.beta[a]); if (x > best) { best = x; arg = a; } }
      return arg;
    }
    update(obs) { this.alpha[obs.action] += obs.reward; this.beta[obs.action] += 1 - obs.reward; }
    estimates() { return Float64Array.from(this.alpha, (a, k) => a / (a + this.beta[k])); }
    parameters() { return [["prior", `Beta(${this.prior[0]}, ${this.prior[1]}) per action`]]; }
    clone() { const c = Object.assign(Object.create(Thompson.prototype), this); c.alpha = this.alpha.slice(); c.beta = this.beta.slice(); return c; }
  }

  function createLearner(cfg, K, ctx) {
    const rng = ctx.rng;
    switch (cfg.kind) {
      case "pure": return new FixedStrategy(oneHot(cfg.action, K), rng);
      case "mixed": return new FixedStrategy(checkMixture(cfg.mixture, K).value, rng);
      case "uniform": return new FixedStrategy(uniform(K), rng);
      case "minimax": return new FixedStrategy(ctx.minimax, rng);
      case "pool": {
        const weights = checkMixture(cfg.pool.weights, cfg.pool.strategies.length).value;
        const index = sampleIndex(weights, rng.pool.next());
        return new FixedStrategy(checkMixture(cfg.pool.strategies[index], K).value, rng, { poolIndex: index });
      }
      case "ucb1": return new UCB1(K, cfg, rng);
      case "ucbv": return new UCBV(K, cfg, rng);
      case "exp3": return new Exp3(K, cfg, rng, ctx.horizon);
      case "hedge": return new Hedge(K, cfg, rng, ctx.horizon);
      case "thompson": return new Thompson(K, cfg, rng);
      default: throw new Error(`Unknown strategy ${cfg.kind}`);
    }
  }

  // ------------------------------------------------------ exploitability ----
  /** Opponent's best-response payoff minus the opponent's game value (always ≥ 0). */
  function exploitability(game, i, mixture, value) {
    if (i === 0) return value - Math.min(...vecMat(mixture, game.payoff));
    return Math.max(...matVec(game.payoff, mixture)) - value;
  }

  /** Stationary candidate strategies of player i (before a match is played). */
  function stationaryCandidates(exp, i, solution, arm = "configured") {
    const K = i === 0 ? exp.game.rows.length : exp.game.cols.length;
    const out = [];
    const add = (label, mixture) => out.push({ label, mixture: Array.from(mixture), exploitability: exploitability(exp.game, i, mixture, solution.value) });
    if (i === 1 && arm !== "configured") {
      const s = exp.sim;
      armPhases(arm, s.horizon, s.epsilon, s.switchRound).forEach((ph) => add(`${ARMS[arm].short}, rounds ${ph.from}–${ph.to}`, ph.mixture));
      return out;
    }
    const cfg = exp.players[i];
    try {
      if (cfg.kind === "pure") add(`${(i === 0 ? exp.game.rows : exp.game.cols)[cfg.action]} (pure)`, oneHot(cfg.action, K));
      else if (cfg.kind === "mixed") add("Fixed mixture", checkMixture(cfg.mixture, K).value);
      else if (cfg.kind === "uniform") add("Uniform", uniform(K));
      else if (cfg.kind === "minimax") add("Minimax", i === 0 ? solution.row : solution.col);
      else if (cfg.kind === "pool") cfg.pool.strategies.forEach((m, k) => add(`Pool strategy ${k + 1}`, checkMixture(m, K).value));
    } catch (err) {
      return [];
    }
    return out;
  }

  // -------------------------------------------------------------- match ----
  function streamsFor(exp, i, repetition) {
    const seed = exp.players[i].seed ?? exp.sim.seed;
    return {
      choice: new Stream("choice", seed, repetition, i),
      binarize: new Stream("binarize", seed, repetition, i),
      pool: new Stream("pool", seed, repetition, i),
      thompsonKey: ["thompson", seed, repetition, i].join("/"),
    };
  }

  /**
   * Create a steppable match.
   * opts.arm: "configured" or a preset deployment (replaces player 2 with an oblivious schedule).
   * opts.repetition: index of the independent repetition (selects the random streams).
   * opts.learnerFactory: optional (cfg, K, ctx, playerIndex) => learner, for testing.
   */
  function createMatch(exp, opts = {}) {
    const arm = opts.arm || exp.sim.deployment;
    const repetition = opts.repetition || 0;
    const errors = validateExperiment(exp, { arm });
    if (errors.length) throw new ConfigError(errors);

    const game = exp.game;
    const T = exp.sim.horizon, eps = exp.sim.epsilon, N = exp.sim.switchRound;
    const K = [game.rows.length, game.cols.length];
    const tables = [playerTable(game, 0), playerTable(game, 1)];
    const solution = solveZeroSum(game.payoff);
    const normalizers = tables.map(makeNormalizer);
    const rngs = [streamsFor(exp, 0, repetition), streamsFor(exp, 1, repetition)];
    const deployment = new Stream("deployment", exp.sim.seed, repetition);
    const scheduled = arm !== "configured";

    const learners = [0, 1].map((i) => {
      if (i === 1 && scheduled) return null;
      const ctx = { rng: rngs[i], horizon: T, minimax: i === 0 ? solution.row : solution.col };
      return (opts.learnerFactory && opts.learnerFactory(exp.players[i], K[i], ctx, i)) || createLearner(exp.players[i], K[i], ctx);
    });

    // Oblivious opponents: a mixture schedule that does not depend on play.
    const schedule = [0, 1].map((i) => {
      if (i === 1 && scheduled) return (t) => armMixture(arm, t, eps, N);
      const L = learners[i];
      return L && L.stationaryMixture ? () => L.stationaryMixture : null;
    });

    // Pseudo-regret needs an oblivious opponent whose expected payoff vector for this
    // player is constant over the horizon (true for all four preset deployments).
    const benchmarks = [0, 1].map((i) => {
      const opp = 1 - i;
      if (!schedule[opp]) {
        return { applies: false, reason: `Not applicable: player ${opp + 1} adapts to play, so there is no stationary benchmark.` };
      }
      const probe = [...new Set([1, T, N, N + 1].filter((t) => t >= 1 && t <= T))];
      const vectors = probe.map((t) => matVec(tables[i], schedule[opp](t)));
      if (!vectors.every((v) => approxEqualVec(v, vectors[0]))) {
        return { applies: false, reason: `Not applicable: player ${opp + 1}'s schedule changes this player's expected payoffs.` };
      }
      const vector = vectors[0];
      return { applies: true, vector, best: argmaxValue(vector), reason: "Benchmark: best response to the opponent's fixed expected payoffs." };
    });

    const candidates = [0, 1].map((i) => {
      const list = stationaryCandidates(exp, i, solution, i === 1 ? arm : "configured");
      const L = learners[i];
      if (L && L.poolIndex !== undefined) list.forEach((c, k) => { c.selected = k === L.poolIndex; });
      return list;
    });

    const info = {
      arm, repetition, K,
      names: [game.rows.slice(), game.cols.slice()],
      solution,
      normalizers: normalizers.map((n) => ({ kind: n.kind, lo: n.lo, hi: n.hi, describe: n.describe })),
      benchmarks: benchmarks.map(({ applies, reason, vector, best }) => ({ applies, reason, vector, best })),
      candidates,
      learners: learners.map((L, i) => (L ? {
        kind: exp.players[i].kind,
        label: KINDS[exp.players[i].kind].label,
        parameters: L.parameters ? L.parameters() : [],
        estimateLabel: L.estimateLabel || null,
        hasWeights: typeof L.weights === "function",
        poolIndex: L.poolIndex,
        feedback: exp.players[i].feedback,
        binarize: exp.players[i].binarize,
      } : { kind: "deployment", label: ARMS[arm].label, parameters: [], estimateLabel: null, hasWeights: false, feedback: null, binarize: false })),
    };

    let t = 0;
    const cumulative = [0, 0];
    const counterfactualTotals = [new Float64Array(K[0]), new Float64Array(K[1])];
    const counts = [new Float64Array(K[0]), new Float64Array(K[1])];
    const pseudo = [0, 0];

    function observe(i, actions, payoffs) {
      if (!learners[i]) return null;
      const cfg = exp.players[i];
      const own = actions[i], opp = actions[1 - i];
      const norm = normalizers[i];
      const full = cfg.feedback === "full-information";
      let reward = norm.apply(payoffs[i]);
      let vector = full ? tables[i].map((row) => norm.apply(row[opp])) : null;
      if (cfg.binarize) {
        // One uniform per action every round, so streams stay aligned across arms.
        const u = Array.from({ length: K[i] }, () => rngs[i].binarize.next());
        if (vector) { vector = vector.map((r, a) => (u[a] < r ? 1 : 0)); reward = vector[own]; }
        else reward = u[own] < reward ? 1 : 0;
      }
      return full
        ? Object.freeze({ action: own, reward, opponentAction: opp, counterfactual: Object.freeze(vector) })
        : Object.freeze({ action: own, reward });
    }

    function step() {
      if (t >= T) return null;
      t += 1;
      // 1. Simultaneous choice: both policies and actions are fixed before any update.
      const policies = [], actions = [];
      for (let i = 0; i < 2; i++) {
        if (learners[i]) {
          const p = learners[i].policy();
          policies.push(p);
          actions.push(learners[i].act(p, t));
        } else {
          const p = schedule[i](t);
          policies.push(p);
          actions.push(sampleIndex(p, deployment.next()));
        }
      }
      // 2. Outcome and learner observations.
      const r = game.payoff[actions[0]][actions[1]];
      const payoffs = [r, 0 - r];
      const normalized = [normalizers[0].apply(payoffs[0]), normalizers[1].apply(payoffs[1])];
      const observations = [observe(0, actions, payoffs), observe(1, actions, payoffs)];
      // 3. Updates.
      for (let i = 0; i < 2; i++) if (learners[i]) learners[i].update(observations[i]);
      // 4. Evaluator (privileged): counterfactuals for regret never reach learners.
      const external = [0, 0], pseudoOut = [null, null], frequencies = [];
      for (let i = 0; i < 2; i++) {
        cumulative[i] += payoffs[i];
        const opp = actions[1 - i];
        for (let a = 0; a < K[i]; a++) counterfactualTotals[i][a] += tables[i][a][opp];
        external[i] = argmaxValue(counterfactualTotals[i]) - cumulative[i];
        counts[i][actions[i]] += 1;
        frequencies.push(Float64Array.from(counts[i], (c) => c / t));
        if (benchmarks[i].applies) {
          pseudo[i] += benchmarks[i].best - benchmarks[i].vector[actions[i]];
          pseudoOut[i] = pseudo[i];
        }
      }
      return {
        t, actions, policies, payoffs, normalized, observations,
        cumulative: cumulative.slice(), external, pseudo: pseudoOut, frequencies,
        estimates: learners.map((L) => (L ? L.estimates() : null)),
        weights: learners.map((L) => (L && L.weights ? L.weights() : null)),
      };
    }

    return {
      info,
      horizon: T,
      get t() { return t; },
      get done() { return t >= T; },
      step,
    };
  }

  function runMatch(exp, opts = {}) {
    const match = createMatch(exp, opts);
    const records = [];
    while (!match.done) records.push(match.step());
    return { info: match.info, records };
  }

  // ------------------------------------------------------- serializing ----
  function defaultExperiment() {
    const p1 = defaultPlayer("ucb1");
    const p2 = defaultPlayer("pure");
    p2.action = 0;
    return {
      version: 1,
      name: "Deterministic vs mixed rewards — UCB1",
      game: presetGame(0.05),
      players: [p1, p2],
      sim: { horizon: 500, repetitions: 50, seed: 2024, switchRound: 250, epsilon: 0.05, rollingWindow: 50, deployment: "configured" },
    };
  }

  function mergePlayer(raw) {
    const d = defaultPlayer(raw && raw.kind ? raw.kind : "uniform");
    if (!raw || typeof raw !== "object") return d;
    return {
      ...d, ...raw,
      pool: { ...d.pool, ...(raw.pool || {}) },
      ucb: { ...d.ucb, ...(raw.ucb || {}) },
      ucbv: { ...d.ucbv, ...(raw.ucbv || {}) },
      exp3: { ...d.exp3, ...(raw.exp3 || {}) },
      hedge: { ...d.hedge, ...(raw.hedge || {}) },
      thompson: { ...d.thompson, ...(raw.thompson || {}) },
    };
  }

  /** Fill defaults for a loaded configuration. Structural problems throw; value problems are left to validateExperiment. */
  function normalizeExperiment(raw) {
    if (!raw || typeof raw !== "object" || !raw.game) throw new Error("Not an experiment file: missing \"game\".");
    const base = defaultExperiment();
    const g = raw.game;
    if (!Array.isArray(g.rows) || !Array.isArray(g.cols) || !Array.isArray(g.payoff)) throw new Error("Game must have rows, cols and payoff arrays.");
    const players = Array.isArray(raw.players) ? raw.players : [];
    return {
      version: 1,
      name: typeof raw.name === "string" ? raw.name : "Loaded experiment",
      description: typeof raw.description === "string" ? raw.description : "",
      game: { rows: g.rows.map(String), cols: g.cols.map(String), payoff: g.payoff.map((r) => (Array.isArray(r) ? r.map((x) => (x === null ? NaN : Number(x))) : [])) },
      players: [mergePlayer(players[0]), mergePlayer(players[1])],
      sim: { ...base.sim, ...(raw.sim || {}) },
    };
  }

  const cloneExperiment = (exp) => normalizeExperiment(JSON.parse(JSON.stringify(exp)));
  const serializeExperiment = (exp) => JSON.stringify(exp, null, 2);

  return {
    ConfigError, Stream, sampleIndex, checkMixture, validateGame, validatePlayer, validateExperiment,
    solveZeroSum, makeNormalizer, playerTable, presetGame, isPresetGame, armMixture, armPhases, ARMS, ARM_KEYS,
    KINDS, defaultPlayer, defaultExp3Gamma, defaultHedgeEta, createLearner, betaWinProbabilities,
    exploitability, stationaryCandidates, createMatch, runMatch, defaultExperiment, normalizeExperiment,
    cloneExperiment, serializeExperiment, matVec, vecMat,
  };
});
