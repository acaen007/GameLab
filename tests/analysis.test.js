"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../src/engine.js");
const A = require("../src/analysis.js");

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test("Welford statistics and Student-t intervals", () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  const s = new A.SeriesStats(1, 1);
  xs.forEach((x) => s.addPoint(0, 0, x));
  s.addPoint(0, 0, NaN);
  const r = s.at(0, 0);
  const mean = 5, sd = Math.sqrt(32 / 7);
  assert.equal(r.n, 8);
  close(r.mean, mean); close(r.sd, sd);
  close(r.hi - r.mean, 2.365 * (sd / Math.sqrt(8)));
  close(A.tCritical(1000), 1.9623, 1e-3);
  close(A.tCritical(40), 2.0211, 1e-3);
});

test("checkpoints always include the first and last round", () => {
  assert.deepEqual(Array.from(A.checkpoints(5)), [1, 2, 3, 4, 5]);
  const c = A.checkpoints(100000, 500);
  assert.equal(c[0], 1); assert.equal(c[c.length - 1], 100000);
  for (let k = 1; k < c.length; k++) assert.ok(c[k] > c[k - 1]);
});

function smallExp() {
  const exp = E.defaultExperiment();
  Object.assign(exp.sim, { horizon: 40, repetitions: 6, switchRound: 20, rollingWindow: 5 });
  return exp;
}

test("Monte Carlo means and paired differences match per-repetition runs", async () => {
  const exp = smallExp();
  const res = await A.runMonteCarlo(exp, { arms: E.ARM_KEYS, yieldFn: async () => {} });
  assert.equal(res.reps, 6);
  const T = exp.sim.horizon;
  const finals = E.ARM_KEYS.map((arm) => Array.from({ length: 6 }, (_, r) => E.runMatch(exp, { arm, repetition: r }).records[T - 1].cumulative[0]));
  E.ARM_KEYS.forEach((arm, a) => {
    const m = res.layouts[a].find((x) => x.key === "cum0").index;
    close(res.stats[a].at(m, res.ts.length - 1).mean, finals[a].reduce((x, y) => x + y) / 6);
  });
  const diff = A.differenceBand(res, 1, 0, "pseudo0");
  const pseudo = E.ARM_KEYS.map((arm) => Array.from({ length: 6 }, (_, r) => E.runMatch(exp, { arm, repetition: r }).records[T - 1].pseudo[0]));
  const d = pseudo[1].map((x, r) => x - pseudo[0][r]);
  const mean = d.reduce((x, y) => x + y) / 6;
  close(diff.mean[T - 1], mean);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / 5);
  close(diff.hi[T - 1] - mean, 2.571 * sd / Math.sqrt(6));
});

test("rolling payoff uses the configured window", () => {
  const exp = smallExp();
  const { info, records } = E.runMatch(exp);
  const traj = new A.Trajectory(info, exp.sim.horizon, 5);
  records.forEach((r) => traj.push(r));
  const roll = traj.get("roll0").ys;
  for (let t = 1; t <= exp.sim.horizon; t++) {
    const w = records.slice(Math.max(0, t - 5), t).map((r) => r.payoffs[0]);
    close(roll[t - 1], w.reduce((a, b) => a + b) / w.length);
  }
});

test("cancellation keeps only completed repetitions", async () => {
  const exp = smallExp();
  exp.sim.horizon = 2000;
  let calls = 0;
  const res = await A.runMonteCarlo(exp, {
    arms: ["S1", "mixture"], sliceMs: 0, yieldFn: async () => { calls += 1; }, isCancelled: () => calls >= 20,
  });
  assert.ok(res.cancelled);
  assert.ok(res.reps < exp.sim.repetitions);
  const k = res.ts.length - 1;
  assert.equal(res.stats[0].at(0, k).n, res.reps);
  assert.equal(res.diffStats[0].at(0, k).n, res.reps);
});

test("CSV export", async () => {
  const exp = smallExp();
  exp.game.rows = ["=cmd", "B, \"x\""];
  const { info, records } = E.runMatch(exp, { arm: "configured" });
  const traj = new A.Trajectory(info, exp.sim.horizon, 5);
  records.forEach((r) => traj.push(r));
  const csv = A.trajectoryCSV([{ arm: "configured", traj }]);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 1 + exp.sim.horizon);
  assert.match(lines[0], /^arm,t,p1_action,p2_action,p1_payoff/);
  assert.ok(csv.includes("'=cmd") || csv.includes("\"B, \"\"x\"\"\""));
  assert.equal(A.csvCell("=1+1"), "'=1+1");
  assert.equal(A.csvCell(-0.5), "-0.5");
  const mc = await A.runMonteCarlo(smallExp(), { arms: ["S1", "mixture"], yieldFn: async () => {} });
  const mcLines = A.monteCarloCSV(mc).trim().split("\n");
  assert.equal(mcLines[0], "series,metric,t,n,mean,ci95_low,ci95_high");
  assert.ok(mcLines.some((l) => l.startsWith("mixture - S1,")));
});

test("thinIndices keeps the ends and respects the budget", () => {
  assert.deepEqual(A.thinIndices(4, 10), [0, 1, 2, 3]);
  const idx = A.thinIndices(5000, 100);
  assert.ok(idx.length <= 100);
  assert.equal(idx[0], 0); assert.equal(idx[idx.length - 1], 4999);
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k] > idx[k - 1]);
});

test("snapshots survive structured cloning with exact final values", async () => {
  const exp = smallExp();
  exp.sim.horizon = 300;
  const { info, records } = E.runMatch(exp, { arm: "S1" });
  const traj = new A.Trajectory(info, exp.sim.horizon, 5);
  records.forEach((r) => traj.push(r));
  const snap = structuredClone(A.snapshotTrajectory(traj, 50));
  assert.ok(snap.ts.length <= 50);
  assert.equal(snap.ts[snap.ts.length - 1], 300);
  assert.equal(snap.final.cum0.mean, records[299].cumulative[0]);
  assert.equal(snap.final.cum0.t, 300);
  assert.equal(snap.series.cum0.ys.length, snap.ts.length);
  assert.equal(snap.info.learners[0].label, info.learners[0].label);
  assert.equal(snap.info.benchmarks[0].applies, true);

  const mc = await A.runMonteCarlo(exp, { arms: ["S1", "mixture"], yieldFn: async () => {} });
  const ms = structuredClone(A.snapshotMonteCarlo(mc, 1, 40));
  const k = mc.ts.length - 1;
  const m = mc.layouts[1].find((x) => x.key === "pseudo0").index;
  const at = mc.stats[1].at(m, k);
  assert.equal(ms.final.pseudo0.mean, at.mean);
  assert.equal(ms.final.pseudo0.hi, at.hi);
  assert.equal(ms.final.pseudo0.n, exp.sim.repetitions);
  assert.ok(ms.series.pseudo0.lo instanceof Float32Array);
  assert.equal(ms.ts.length, ms.series.pseudo0.hi.length);
});
