"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../src/engine.js");
const Presets = require("../src/presets.js");

const close = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, msg || `${a} ≉ ${b}`);

function presetExp(overrides = {}) {
  const exp = E.defaultExperiment();
  Object.assign(exp.sim, { horizon: 200, repetitions: 5, switchRound: 100 }, overrides.sim || {});
  if (!(overrides.sim && "switchRound" in overrides.sim)) exp.sim.switchRound = Math.floor(exp.sim.horizon / 2);
  if (overrides.p1) Object.assign(exp.players[0], overrides.p1);
  if (overrides.p2) Object.assign(exp.players[1], overrides.p2);
  return exp;
}

test("mixture validation", () => {
  assert.deepEqual(Array.from(E.checkMixture([0.25, 0.75], 2).value), [0.25, 0.75]);
  assert.match(E.checkMixture([0.5, 0.6], 2).errors[0], /sum to 1\.1/);
  assert.match(E.checkMixture([1.5, -0.5], 2).errors.join(), /negative/);
  assert.match(E.checkMixture([1], 2).errors[0], /expected 2/);
  assert.match(E.checkMixture([NaN, 1], 2).errors[0], /not a number/);
  close(E.checkMixture([1 / 3, 1 / 3, 1 / 3], 3).value.reduce((a, b) => a + b), 1);
  const exp = presetExp({ p2: { kind: "mixed", mixture: [0.2, 0.2, 0.2] } });
  assert.ok(E.validateExperiment(exp).some((m) => /Player 2 mixed strategy: probabilities sum/.test(m)));
  const pool = presetExp({ p2: { kind: "pool", pool: { strategies: [[1, 0, 0]], weights: [0.5] } } });
  assert.ok(E.validateExperiment(pool).some((m) => /pool selection weights/.test(m)));
});

test("preset ε bounds and game checks", () => {
  for (const eps of [0, 0.5, -0.1, NaN]) {
    const exp = presetExp({ sim: { epsilon: eps } });
    assert.ok(E.validateExperiment(exp).some((m) => /0 < ε < 0\.5/.test(m)), `ε=${eps}`);
  }
  const exp = presetExp();
  exp.game.payoff[0][0] = 0.7;
  assert.deepEqual(E.validateExperiment(exp), [], "configured P2 does not need the preset matrix");
  assert.ok(E.validateExperiment(exp, { arm: "S1" }).some((m) => /Preset deployments need/.test(m)));
  exp.game.rows[1] = "A";
  assert.ok(E.validateGame(exp.game).some((m) => /unique/.test(m)));
});

test("LP: preset value and minimax", () => {
  const sol = E.solveZeroSum(E.presetGame(0.05).payoff);
  close(sol.value, 0.5);
  close(sol.row[0], 0.5); close(sol.row[1], 0.5);
  const rps = E.solveZeroSum([[0, -1, 1], [1, 0, -1], [-1, 1, 0]]);
  close(rps.value, 0);
  rps.row.forEach((x) => close(x, 1 / 3));
});

test("LP: equilibrium property on random matrices", () => {
  const rng = new E.Stream("lp-test");
  for (let trial = 0; trial < 200; trial++) {
    const m = 1 + Math.floor(rng.next() * 6), n = 1 + Math.floor(rng.next() * 6);
    const A = Array.from({ length: m }, () => Array.from({ length: n }, () => Math.round((rng.next() * 20 - 10) * 4) / 4));
    const { value, row, col } = E.solveZeroSum(A);
    close(row.reduce((a, b) => a + b), 1, 1e-9);
    close(col.reduce((a, b) => a + b), 1, 1e-9);
    for (const x of [...row, ...col]) assert.ok(x >= 0);
    for (const v of E.vecMat(row, A)) assert.ok(v >= value - 1e-7, `row guarantee trial ${trial}`);
    for (const v of E.matVec(A, col)) assert.ok(v <= value + 1e-7, `col guarantee trial ${trial}`);
  }
});

test("normalization is a fixed documented affine map", () => {
  const id = E.makeNormalizer([[0, 0.3], [1, 0.5]]);
  assert.equal(id.kind, "identity");
  assert.equal(id.apply(0.3), 0.3);
  const aff = E.makeNormalizer([[-2, 0], [6, 1]]);
  assert.equal(aff.kind, "affine");
  close(aff.apply(-2), 0); close(aff.apply(6), 1); close(aff.apply(2), 0.5);
  assert.equal(E.makeNormalizer([[3, 3]]).apply(3), 0.5);
  const p2 = E.makeNormalizer(E.playerTable(E.presetGame(0.05), 1));
  close(p2.apply(-0.55), 0.45); close(p2.apply(-1), 0); close(p2.apply(0), 1);
  // Actual payoffs are tracked separately from normalized rewards.
  const exp = presetExp({ sim: { horizon: 20 }, p1: { kind: "uniform" } });
  exp.game = { rows: ["X", "Y"], cols: ["L", "R"], payoff: [[4, -2], [0, 2]] };
  exp.players[1] = E.defaultPlayer("uniform");
  const { records } = E.runMatch(exp);
  for (const r of records) {
    assert.equal(r.payoffs[0], exp.game.payoff[r.actions[0]][r.actions[1]]);
    close(r.normalized[0], (r.payoffs[0] + 2) / 6);
  }
});

test("binarization: Bernoulli(r~) drawn from one uniform per action, reconstructable exactly", () => {
  for (const feedback of ["reward-only", "full-information"]) {
    const exp = presetExp({ sim: { horizon: 300, seed: 11 }, p1: { kind: "exp3", binarize: true, feedback } });
    exp.players[1] = E.defaultPlayer("mixed");
    exp.players[1].mixture = [0.4, 0.3, 0.3];
    const { records } = E.runMatch(exp, { repetition: 3 });
    const s = new E.Stream("binarize", 11, 3, 0);
    let mean = 0;
    for (const r of records) {
      const u = [s.next(), s.next()];
      const obs = r.observations[0];
      const rt = E.presetGame(0.05).payoff.map((row) => row[r.actions[1]]);
      const bits = rt.map((x, a) => (u[a] < x ? 1 : 0));
      assert.equal(obs.reward, bits[r.actions[0]]);
      if (feedback === "full-information") assert.deepEqual(Array.from(obs.counterfactual), bits);
      mean += r.normalized[0];
    }
    assert.ok(mean > 0);
  }
});

test("simultaneity: both actions are fixed before either player is updated", () => {
  const log = [];
  const spy = (name) => ({
    policy: () => Float64Array.of(0.5, 0.5, 0.5).subarray(0, name === "P1" ? 2 : 3),
    act: (p, t) => { log.push(`${name} act ${t}`); return 0; },
    update: (obs) => { log.push(`${name} update`); assert.ok(Object.isFrozen(obs)); },
    estimates: () => null,
  });
  const exp = presetExp({ sim: { horizon: 3 } });
  exp.players[1] = E.defaultPlayer("uniform");
  E.runMatch(exp, { learnerFactory: (cfg, K, ctx, i) => spy(i === 0 ? "P1" : "P2") });
  for (let t = 1; t <= 3; t++) {
    const base = (t - 1) * 4;
    assert.deepEqual(log.slice(base, base + 4), [`P1 act ${t}`, `P2 act ${t}`, "P1 update", "P2 update"]);
  }
});

test("feedback isolation: reward-only sees only own action and reward", () => {
  const exp = presetExp({ sim: { horizon: 50 } });
  exp.players[1] = E.defaultPlayer("exp3");
  exp.players[1].feedback = "full-information";
  const { records } = E.runMatch(exp);
  for (const r of records) {
    assert.deepEqual(Object.keys(r.observations[0]).sort(), ["action", "reward"]);
    assert.ok(Object.isFrozen(r.observations[0]));
    assert.deepEqual(Object.keys(r.observations[1]).sort(), ["action", "counterfactual", "opponentAction", "reward"]);
    assert.equal(r.observations[1].opponentAction, r.actions[0]);
  }
});

test("Hedge requires full information; UCB1 and EXP3 run on reward-only feedback", () => {
  const bad = presetExp({ p1: { kind: "hedge" } });
  const errs = E.validateExperiment(bad);
  assert.ok(errs.some((m) => /Hedge needs full-information/.test(m)));
  assert.throws(() => E.createMatch(bad), E.ConfigError);
  const learner = E.createLearner({ ...E.defaultPlayer("hedge"), feedback: "full-information" }, 2, { rng: {}, horizon: 10 });
  assert.throws(() => learner.update({ action: 0, reward: 1 }), /requires full information/);
  for (const kind of ["ucb1", "exp3", "thompson"]) {
    const exp = presetExp({ p1: { kind } });
    assert.deepEqual(E.validateExperiment(exp, { arms: E.ARM_KEYS }), []);
    assert.equal(E.runMatch(exp, { arm: "mixture" }).records.length, 200);
  }
  const ok = presetExp({ p1: { kind: "hedge", feedback: "full-information" } });
  assert.equal(E.runMatch(ok).records.length, 200);
});

test("UCB-V: index formula, validation and reward-only play", () => {
  const cfg = E.defaultPlayer("ucbv");
  assert.deepEqual(cfg.ucbv, { zeta: 1.2, c: 1, initOrder: "random" });
  const L = E.createLearner(cfg, 2, { rng: { choice: new E.Stream("t") }, horizon: 10 });
  for (const [action, reward] of [[0, 1], [0, 0], [0, 1], [1, 0.5], [1, 0.5]]) L.update({ action, reward });
  const explore = 1.2 * Math.log(5);
  const idx = L.indices();
  close(idx[0], 2 / 3 + Math.sqrt((2 * (2 / 9) * explore) / 3) + (3 * explore) / 3, 1e-12);
  close(idx[1], 0.5 + (3 * explore) / 2, 1e-12, "zero variance leaves only the 3cE/n term");
  assert.deepEqual(Array.from(L.policy()), [0, 1]);
  const copy = L.clone();
  copy.update({ action: 1, reward: 1 });
  assert.equal(L.n[1], 2, "clone does not share counts");
  for (const [k, v, msg] of [["zeta", 0, /ζ must be > 0/], ["c", -1, /c must be ≥ 0/], ["initOrder", "x", /initialization order/]]) {
    const exp = presetExp({ p1: { kind: "ucbv", ucbv: { ...cfg.ucbv, [k]: v } } });
    assert.ok(E.validateExperiment(exp).some((m) => msg.test(m)), k);
  }
  const exp = presetExp({ p1: { kind: "ucbv" } });
  assert.deepEqual(E.validateExperiment(exp, { arms: E.ARM_KEYS }), []);
  const { info, records } = E.runMatch(exp, { arm: "mixture" });
  assert.equal(records.length, 200);
  assert.equal(info.learners[0].label, "UCB-V (variance-aware UCB)");
  assert.deepEqual(E.normalizeExperiment(JSON.parse(JSON.stringify(exp))).players[0].ucbv, cfg.ucbv);
});

test("preset: every deployment gives the same expected payoffs to P1", () => {
  const eps = 0.07, N = 30, T = 60;
  for (const arm of E.ARM_KEYS) {
    for (let t = 1; t <= T; t++) {
      const v = E.matVec(E.presetGame(eps).payoff, E.armMixture(arm, t, eps, N));
      close(v[0], 0.5 + eps, 1e-12); close(v[1], 0.5 - eps, 1e-12);
    }
  }
});

test("preset pseudo-regret equals 2ε × number of B choices", () => {
  const eps = 0.05;
  for (const p1 of [{ kind: "ucb1" }, { kind: "ucbv" }, { kind: "exp3" }, { kind: "thompson" }, { kind: "ucb1", binarize: true }, { kind: "exp3", binarize: true }]) {
    for (const arm of E.ARM_KEYS) {
      const exp = presetExp({ p1 });
      const { info, records } = E.runMatch(exp, { arm, repetition: 1 });
      assert.ok(info.benchmarks[0].applies, arm);
      let nB = 0;
      for (const r of records) {
        if (r.actions[0] === 1) nB += 1;
        close(r.pseudo[0], 2 * eps * nB, 1e-9, `${p1.kind} ${arm} t=${r.t}`);
      }
      assert.equal(info.benchmarks[1].applies, false, "P1 adapts, so P2 has no stationary benchmark");
    }
  }
});

test("external regret matches a direct computation", () => {
  const exp = presetExp({ sim: { horizon: 150 } });
  exp.game = { rows: ["R", "P", "S"], cols: ["R", "P", "S"], payoff: [[0, -1, 1], [1, 0, -1], [-1, 1, 0]] };
  exp.players = [E.defaultPlayer("exp3"), E.defaultPlayer("ucb1")];
  const { records } = E.runMatch(exp);
  const tables = [E.playerTable(exp.game, 0), E.playerTable(exp.game, 1)];
  const cf = [[0, 0, 0], [0, 0, 0]], got = [0, 0];
  for (const r of records) {
    for (const i of [0, 1]) {
      got[i] += r.payoffs[i];
      for (let a = 0; a < 3; a++) cf[i][a] += tables[i][a][r.actions[1 - i]];
      close(r.external[i], Math.max(...cf[i]) - got[i], 1e-9);
    }
    assert.deepEqual(r.pseudo, [null, null]);
  }
});

test("exploitability of stationary candidates", () => {
  const exp = presetExp();
  const sol = E.solveZeroSum(exp.game.payoff);
  close(E.exploitability(exp.game, 1, [1, 0, 0], sol.value), 0.05);
  close(E.exploitability(exp.game, 1, [0, 0.55, 0.45], sol.value), 0.05);
  close(E.exploitability(exp.game, 0, sol.row, sol.value), 0);
  close(E.exploitability(exp.game, 1, sol.col, sol.value), 0);
  for (const arm of E.ARM_KEYS) {
    const c = E.stationaryCandidates(exp, 1, sol, arm);
    assert.equal(c.length, arm.includes("then") ? 2 : 1);
    c.forEach((x) => close(x.exploitability, 0.05));
  }
  assert.deepEqual(E.stationaryCandidates(exp, 0, sol), [], "learners have no stationary exploitability");
});

// Exact enumeration of UCB1 over all initialization orders, tie-breaks and opponent draws.
function enumerateUCB(T, eps, oppMixture) {
  const game = E.presetGame(eps);
  const cfg = E.defaultPlayer("ucb1");
  let expectedB = 0, totalProb = 0;
  const recurse = (learner, t, prob, nB) => {
    if (t > T) { expectedB += prob * nB; totalProb += prob; return; }
    const p = learner.policy();
    p.forEach((pa, a) => {
      if (!(pa > 0)) return;
      oppMixture.forEach((qb, b) => {
        if (!(qb > 0)) return;
        const next = learner.clone();
        next.update({ action: a, reward: game.payoff[a][b] });
        recurse(next, t + 1, prob * pa * qb, nB + (a === 1 ? 1 : 0));
      });
    });
  };
  recurse(E.createLearner(cfg, 2, { rng: {}, horizon: T }), 1, 1, 0);
  close(totalProb, 1, 1e-12);
  return 2 * eps * expectedB;
}

// Independent textbook UCB1 (no engine code) for cross-checking the enumeration.
function enumerateUCBReference(T, eps, q) {
  const A = [[0.5 + eps, 1, 0], [0.5 - eps, 0, 1]];
  let out = 0;
  const go = (n, s, t, prob, nB) => {
    if (t > T) { out += prob * nB; return; }
    let choices;
    const unseen = [0, 1].filter((a) => n[a] === 0);
    if (unseen.length) choices = unseen;
    else {
      const tot = n[0] + n[1];
      const idx = [0, 1].map((a) => s[a] / n[a] + Math.sqrt((2 * Math.log(tot)) / n[a]));
      const m = Math.max(...idx);
      choices = [0, 1].filter((a) => m - idx[a] <= 1e-12);
    }
    for (const a of choices) {
      q.forEach((qb, b) => {
        if (!qb) return;
        const n2 = n.slice(), s2 = s.slice();
        n2[a] += 1; s2[a] += A[a][b];
        go(n2, s2, t + 1, (prob * qb) / choices.length, nB + (a === 1));
      });
    }
  };
  go([0, 0], [0, 0], 1, 1, 0);
  return 2 * eps * out;
}

test("exact regression: UCB1, ε = 0.05, T = 4 (enumeration)", () => {
  const eps = 0.05;
  close(enumerateUCB(4, eps, [1, 0, 0]), 0.2, 1e-12);
  close(enumerateUCB(4, eps, [0, 0.5 + eps, 0.5 - eps]), 0.1887625, 1e-12);
  close(enumerateUCBReference(4, eps, [1, 0, 0]), 0.2, 1e-12);
  close(enumerateUCBReference(4, eps, [0, 0.5 + eps, 0.5 - eps]), 0.1887625, 1e-12);
  // The engine's match loop agrees on the deterministic arm for every seed.
  for (let seed = 0; seed < 20; seed++) {
    const exp = presetExp({ sim: { horizon: 4, switchRound: 2, seed } });
    close(E.runMatch(exp, { arm: "S1" }).records[3].pseudo[0], 0.2, 1e-12);
  }
});

test("reproducibility and independent repetitions", () => {
  const exp = presetExp({ p1: { kind: "thompson", binarize: true } });
  const key = (res) => res.records.map((r) => r.actions.join("")).join("|");
  const a = E.runMatch(exp, { arm: "mixture", repetition: 2 });
  const b = E.runMatch(E.cloneExperiment(exp), { arm: "mixture", repetition: 2 });
  assert.equal(key(a), key(b));
  assert.deepEqual(a.records.at(-1).cumulative, b.records.at(-1).cumulative);
  assert.notEqual(key(a), key(E.runMatch(exp, { arm: "mixture", repetition: 3 })));
  const other = E.cloneExperiment(exp); other.sim.seed = 99;
  assert.notEqual(key(a), key(E.runMatch(other, { arm: "mixture", repetition: 2 })));
  const p1Seed = E.cloneExperiment(exp); p1Seed.players[0].seed = 5;
  const c = E.runMatch(p1Seed, { arm: "mixture", repetition: 2 });
  assert.deepEqual(c.records.map((r) => r.actions[1]), a.records.map((r) => r.actions[1]), "learner seed leaves opponent stream unchanged");
});

test("common random numbers: separate learner and opponent streams aligned across arms", () => {
  const exp = presetExp({ p1: { kind: "mixed", mixture: [0.5, 0.5] } });
  const runs = Object.fromEntries(E.ARM_KEYS.map((arm) => [arm, E.runMatch(exp, { arm, repetition: 4 }).records]));
  const p1 = (arm) => runs[arm].map((r) => r.actions[0]).join("");
  for (const arm of E.ARM_KEYS) assert.equal(p1(arm), p1("S1"), "P1 stream unaffected by the opponent's deployment");
  const N = exp.sim.switchRound;
  for (let t = 0; t < exp.sim.horizon; t++) {
    if (t < N) assert.equal(runs.mixture[t].actions[1], runs.mix_then_S1[t].actions[1]);
    else assert.equal(runs.mixture[t].actions[1], runs.S1_then_mix[t].actions[1]);
  }
});

test("horizon-based parameters use the full horizon and are identical across arms", () => {
  const exp = presetExp({ sim: { horizon: 1000, switchRound: 400 }, p1: { kind: "exp3" } });
  const params = E.ARM_KEYS.map((arm) => JSON.stringify(E.createMatch(exp, { arm }).info.learners[0].parameters));
  assert.equal(new Set(params).size, 1);
  close(E.createMatch(exp).info.learners[0].parameters[0][1], E.defaultExp3Gamma(2, 1000));
  exp.players[0].exp3.gamma = 0.2;
  close(E.createMatch(exp).info.learners[0].parameters[0][1], 0.2);
  close(E.defaultExp3Gamma(2, 1000), Math.sqrt((2 * Math.log(2)) / ((Math.E - 1) * 1000)));
});

test("fixed mixture resamples every round; a pool commits to one strategy per match", () => {
  const eps = 0.05, mix = [0, 0.5 + eps, 0.5 - eps];
  const mixed = presetExp({ p2: { kind: "mixed", mixture: mix } });
  const r1 = E.runMatch(mixed).records;
  assert.ok(new Set(r1.map((r) => r.actions[1])).size === 2, "both S2 and S3 appear in one match");
  const pool = presetExp({ p2: { kind: "pool", pool: { strategies: [[1, 0, 0], mix], weights: [0.5, 0.5] } } });
  const picks = [];
  for (let rep = 0; rep < 200; rep++) {
    const { info, records } = E.runMatch(pool, { repetition: rep });
    const k = info.learners[1].poolIndex;
    picks.push(k);
    const cols = new Set(records.map((r) => r.actions[1]));
    if (k === 0) assert.deepEqual([...cols], [0]);
    else assert.ok(!cols.has(0));
    records.forEach((r) => assert.deepEqual(Array.from(r.policies[1]), k === 0 ? [1, 0, 0] : mix));
    assert.equal(info.candidates[1].filter((c) => c.selected).length, 1);
  }
  const share = picks.filter((k) => k === 0).length / picks.length;
  assert.ok(share > 0.35 && share < 0.65, `pool selection share ${share}`);
});

test("Thompson display probabilities", () => {
  const p = E.betaWinProbabilities(Float64Array.of(1, 1), Float64Array.of(1, 1));
  close(p[0], 0.5, 1e-6);
  const q = E.betaWinProbabilities(Float64Array.of(30, 10, 2), Float64Array.of(10, 30, 2));
  close(q.reduce((a, b) => a + b), 1, 1e-9);
  assert.ok(q[0] > q[2] && q[2] > q[1]);
});

test("serialization round-trip and built-in presets", () => {
  for (const { id, experiment } of Presets.list) {
    const exp = E.normalizeExperiment(JSON.parse(E.serializeExperiment(experiment)));
    assert.deepEqual(exp, E.normalizeExperiment(experiment), id);
    assert.deepEqual(E.validateExperiment(exp), [], id);
    if (E.isPresetGame(exp.game, exp.sim.epsilon)) assert.deepEqual(E.validateExperiment(exp, { arms: E.ARM_KEYS }), [], id);
  }
  assert.throws(() => E.normalizeExperiment({ foo: 1 }), /missing "game"/);
  const fs = require("node:fs"), path = require("node:path");
  for (const { id, experiment } of Presets.list) {
    const file = path.join(__dirname, "..", "presets", `${id}.json`);
    assert.ok(fs.existsSync(file), `missing ${file}; run npm run presets`);
    assert.deepEqual(E.normalizeExperiment(JSON.parse(fs.readFileSync(file, "utf8"))), E.normalizeExperiment(experiment), id);
  }
});
