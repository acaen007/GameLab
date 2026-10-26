/*
 * Metrics, Monte Carlo aggregation and CSV export. No DOM access.
 * Browser: window.NFAnalysis. Node: module.exports.
 */
(function (root, factory) {
  const api = factory(root.NFEngine || (typeof require === "function" ? require("./engine.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NFAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (E) {
  "use strict";

  // ------------------------------------------------------------- layout ----
  /**
   * Metric layout for one match: a flat list of named per-round series.
   * Groups: payoff, regret, policy, freq, est, weight.
   */
  function metricLayout(info) {
    const out = [];
    const P = ["P1", "P2"];
    for (let i = 0; i < 2; i++) {
      out.push({ key: `cum${i}`, group: "payoff", player: i, label: `${P[i]} cumulative payoff` });
      out.push({ key: `avg${i}`, group: "payoff", player: i, label: `${P[i]} average payoff` });
      out.push({ key: `roll${i}`, group: "payoff", player: i, label: `${P[i]} rolling payoff` });
    }
    for (let i = 0; i < 2; i++) out.push({ key: `ext${i}`, group: "regret", player: i, label: `${P[i]} external regret` });
    for (let i = 0; i < 2; i++) if (info.benchmarks[i].applies) out.push({ key: `pseudo${i}`, group: "regret", player: i, label: `${P[i]} pseudo-regret` });
    for (let i = 0; i < 2; i++) {
      info.names[i].forEach((n, a) => out.push({ key: `pol${i}_${a}`, group: "policy", player: i, action: a, label: `${P[i]} P(${n})` }));
      info.names[i].forEach((n, a) => out.push({ key: `freq${i}_${a}`, group: "freq", player: i, action: a, label: `${P[i]} freq(${n})` }));
      if (info.learners[i].estimateLabel) info.names[i].forEach((n, a) => out.push({ key: `est${i}_${a}`, group: "est", player: i, action: a, label: `${P[i]} estimate(${n})` }));
      if (info.learners[i].hasWeights) info.names[i].forEach((n, a) => out.push({ key: `w${i}_${a}`, group: "weight", player: i, action: a, label: `${P[i]} weight(${n})` }));
    }
    out.forEach((m, k) => { m.index = k; });
    return out;
  }

  /** Stateful per-round extractor (keeps the rolling-window buffers). */
  function makeExtractor(layout, window) {
    const rings = [new Float64Array(window), new Float64Array(window)];
    const rsum = [0, 0];
    const index = new Map(layout.map((m) => [m.key, m.index]));
    const values = new Float64Array(layout.length);
    return function extract(rec) {
      const t = rec.t;
      for (let i = 0; i < 2; i++) {
        const slot = (t - 1) % window;
        if (t > window) rsum[i] -= rings[i][slot];
        rings[i][slot] = rec.payoffs[i];
        rsum[i] += rec.payoffs[i];
        values[index.get(`cum${i}`)] = rec.cumulative[i];
        values[index.get(`avg${i}`)] = rec.cumulative[i] / t;
        values[index.get(`roll${i}`)] = rsum[i] / Math.min(t, window);
        values[index.get(`ext${i}`)] = rec.external[i];
        if (index.has(`pseudo${i}`)) values[index.get(`pseudo${i}`)] = rec.pseudo[i] ?? NaN;
        const K = rec.policies[i].length;
        for (let a = 0; a < K; a++) {
          values[index.get(`pol${i}_${a}`)] = rec.policies[i][a];
          values[index.get(`freq${i}_${a}`)] = rec.frequencies[i][a];
          if (index.has(`est${i}_${a}`)) values[index.get(`est${i}_${a}`)] = rec.estimates[i][a];
          if (index.has(`w${i}_${a}`)) values[index.get(`w${i}_${a}`)] = rec.weights[i][a];
        }
      }
      return values;
    };
  }

  /** Rounds at which series are stored: every round up to maxPoints, else an even grid that always includes 1 and T. */
  function checkpoints(T, maxPoints = 2000) {
    if (T <= maxPoints) return Int32Array.from({ length: T }, (_, k) => k + 1);
    const out = new Set([1, T]);
    for (let k = 0; k < maxPoints; k++) out.add(Math.max(1, Math.round(((k + 1) * T) / maxPoints)));
    return Int32Array.from([...out].sort((a, b) => a - b));
  }

  // --------------------------------------------------------- trajectory ----
  /** One match, stored at checkpoints (with every round's actions when T is small enough). */
  class Trajectory {
    constructor(info, horizon, window, maxPoints = 5000) {
      this.info = info;
      this.layout = metricLayout(info);
      this.extract = makeExtractor(this.layout, window);
      this.ts = checkpoints(horizon, maxPoints);
      this.series = this.layout.map(() => new Float64Array(this.ts.length).fill(NaN));
      this.rows = [];
      this.keepRows = horizon <= 20000;
      this.next = 0;
      this.length = 0;
      this.last = null;
    }
    push(rec) {
      const v = this.extract(rec);
      this.last = rec;
      if (this.keepRows) this.rows.push(rowFromRecord(rec));
      if (this.next < this.ts.length && this.ts[this.next] === rec.t) {
        for (let m = 0; m < v.length; m++) this.series[m][this.next] = v[m];
        this.next += 1;
        this.length = this.next;
      }
    }
    get(key) {
      const m = this.layout.find((x) => x.key === key);
      return m ? { ts: this.ts.subarray(0, this.length), ys: this.series[m.index].subarray(0, this.length) } : null;
    }
  }

  function rowFromRecord(rec) {
    return {
      t: rec.t,
      actions: rec.actions.slice(),
      payoffs: rec.payoffs.slice(),
      feedback: rec.observations.map((o) => (o ? o.reward : null)),
    };
  }

  // ----------------------------------------------------------- statistics ----
  const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145,
    2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

  /** Two-sided 95% Student-t critical value. */
  function tCritical(df) {
    if (!(df >= 1)) return NaN;
    if (df < T975.length) return T975[Math.floor(df)];
    const z = 1.959963984540054;
    const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
    return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
  }

  /** Pointwise Welford accumulator for many series of equal length. Non-finite values are skipped. */
  class SeriesStats {
    constructor(nSeries, nPoints) {
      this.nSeries = nSeries; this.nPoints = nPoints;
      this.n = Array.from({ length: nSeries }, () => new Float64Array(nPoints));
      this.mean = Array.from({ length: nSeries }, () => new Float64Array(nPoints));
      this.m2 = Array.from({ length: nSeries }, () => new Float64Array(nPoints));
    }
    addPoint(s, k, x) {
      if (!Number.isFinite(x)) return;
      const n = (this.n[s][k] += 1);
      const d = x - this.mean[s][k];
      this.mean[s][k] += d / n;
      this.m2[s][k] += d * (x - this.mean[s][k]);
    }
    /** {mean, lo, hi, n, sd} at one point. */
    at(s, k) {
      const n = this.n[s][k], mean = n ? this.mean[s][k] : NaN;
      if (n < 2) return { n, mean, lo: NaN, hi: NaN, sd: NaN };
      const sd = Math.sqrt(this.m2[s][k] / (n - 1));
      const h = tCritical(n - 1) * (sd / Math.sqrt(n));
      return { n, mean, lo: mean - h, hi: mean + h, sd };
    }
    band(s) {
      const mean = new Float64Array(this.nPoints), lo = new Float64Array(this.nPoints), hi = new Float64Array(this.nPoints);
      for (let k = 0; k < this.nPoints; k++) { const r = this.at(s, k); mean[k] = r.mean; lo[k] = r.lo; hi[k] = r.hi; }
      return { mean, lo, hi };
    }
  }

  // --------------------------------------------------------- Monte Carlo ----
  const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Run R independent repetitions of each arm. Within a repetition every arm uses the
   * same random streams (common random numbers), so arm differences are paired.
   * Only fully completed repetitions are committed, so cancellation leaves valid statistics.
   *
   * opts: arms, onProgress({done, total, reps}), isCancelled(), sliceMs, yieldFn, maxPoints.
   */
  async function runMonteCarlo(exp, opts = {}) {
    const arms = opts.arms || [exp.sim.deployment];
    const errors = E.validateExperiment(exp, { arms });
    if (errors.length) throw new E.ConfigError(errors);
    const T = exp.sim.horizon, R = exp.sim.repetitions, W = exp.sim.rollingWindow;
    const ts = checkpoints(T, opts.maxPoints || 1000);
    const sliceMs = opts.sliceMs ?? 25;
    const yieldFn = opts.yieldFn || defaultYield;
    const isCancelled = opts.isCancelled || (() => false);
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

    const infos = arms.map((arm) => E.createMatch(exp, { arm, repetition: 0 }).info);
    const layouts = infos.map(metricLayout);
    const stats = layouts.map((L) => new SeriesStats(L.length, ts.length));
    // Paired differences on metrics shared by all arms, for every ordered pair (j - b).
    const shared = layouts[0].filter((m) => layouts.every((L) => L.some((x) => x.key === m.key))).map((m) => m.key);
    const pairs = [];
    for (let b = 0; b < arms.length; b++) for (let j = 0; j < arms.length; j++) if (j !== b) pairs.push([j, b]);
    const diffStats = pairs.map(() => new SeriesStats(shared.length, ts.length));
    const sharedIdx = layouts.map((L) => shared.map((key) => L.find((m) => m.key === key).index));
    const finalPool = arms.map(() => []);

    const total = R * arms.length * T;
    let done = 0, reps = 0, cancelled = false, sliceStart = now();

    outer: for (let r = 0; r < R; r++) {
      const buffers = [];
      for (let a = 0; a < arms.length; a++) {
        const match = E.createMatch(exp, { arm: arms[a], repetition: r });
        const extract = makeExtractor(layouts[a], W);
        const buf = layouts[a].map(() => new Float64Array(ts.length));
        let k = 0;
        while (!match.done) {
          const rec = match.step();
          const v = extract(rec);
          if (ts[k] === rec.t) { for (let m = 0; m < v.length; m++) buf[m][k] = v[m]; k += 1; }
          done += 1;
          if ((done & 255) === 0 && now() - sliceStart > sliceMs) {
            if (opts.onProgress) opts.onProgress({ done, total, reps });
            await yieldFn();
            sliceStart = now();
            if (isCancelled()) { cancelled = true; break outer; }
          }
        }
        buffers.push(buf);
        finalPool[a].push(match.info.learners[0].poolIndex ?? match.info.learners[1].poolIndex ?? null);
      }
      for (let a = 0; a < arms.length; a++) {
        for (let m = 0; m < layouts[a].length; m++) for (let k = 0; k < ts.length; k++) stats[a].addPoint(m, k, buffers[a][m][k]);
      }
      pairs.forEach(([j, b], p) => {
        shared.forEach((_, s) => {
          const xj = buffers[j][sharedIdx[j][s]], xb = buffers[b][sharedIdx[b][s]];
          for (let k = 0; k < ts.length; k++) diffStats[p].addPoint(s, k, xj[k] - xb[k]);
        });
      });
      reps += 1;
    }
    if (opts.onProgress) opts.onProgress({ done, total, reps });
    return { exp: E.cloneExperiment(exp), arms, ts, infos, layouts, stats, shared, pairs, diffStats, reps, cancelled, poolSelections: finalPool };
  }

  /** Paired difference band (arm j minus baseline b) for a shared metric key. */
  function differenceBand(result, j, b, key) {
    const p = result.pairs.findIndex(([x, y]) => x === j && y === b);
    const s = result.shared.indexOf(key);
    if (p < 0 || s < 0) return null;
    return result.diffStats[p].band(s);
  }

  function armBand(result, a, key) {
    const m = result.layouts[a].find((x) => x.key === key);
    return m ? result.stats[a].band(m.index) : null;
  }

  // ----------------------------------------------------------- snapshots ----
  /** Plain-data subset of match info used by charts and summaries (structured-clone safe). */
  function compactInfo(info) {
    return {
      names: info.names.map((n) => n.slice()),
      solution: { value: info.solution.value },
      benchmarks: info.benchmarks.map((b) => ({ applies: b.applies, reason: b.reason, vector: b.vector ? Array.from(b.vector) : null })),
      candidates: info.candidates.map((list) => list.map((c) => ({ label: c.label, exploitability: c.exploitability, selected: !!c.selected }))),
      learners: info.learners.map((L) => ({ kind: L.kind, label: L.label, estimateLabel: L.estimateLabel, hasWeights: L.hasWeights })),
    };
  }

  /** At most maxPoints evenly spaced indices into 0..n-1, always keeping the first and last. */
  function thinIndices(n, maxPoints) {
    if (n <= maxPoints) return Array.from({ length: n }, (_, k) => k);
    const out = new Set([0, n - 1]);
    for (let k = 1; k < maxPoints - 1; k++) out.add(Math.round((k * (n - 1)) / (maxPoints - 1)));
    return [...out].sort((a, b) => a - b);
  }

  const pick = (arr, idx) => Float32Array.from(idx, (k) => arr[k]);

  /** Storable copy of a trajectory: series thinned to maxPoints, final values exact. */
  function snapshotTrajectory(traj, maxPoints = 1000) {
    const n = traj.length;
    const idx = thinIndices(n, maxPoints);
    const series = {}, final = {};
    for (const m of traj.layout) {
      const ys = traj.series[m.index];
      series[m.key] = { ys: pick(ys, idx) };
      final[m.key] = { mean: n ? ys[n - 1] : NaN, n: 1, t: n ? traj.ts[n - 1] : 0 };
    }
    return { info: compactInfo(traj.info), ts: Float64Array.from(idx, (k) => traj.ts[k]), series, final };
  }

  /** Storable copy of arm a of a Monte Carlo result (mean and 95% band). */
  function snapshotMonteCarlo(result, a, maxPoints = 1000) {
    const n = result.ts.length;
    const idx = thinIndices(n, maxPoints);
    const series = {}, final = {};
    for (const m of result.layouts[a]) {
      const b = result.stats[a].band(m.index);
      series[m.key] = { ys: pick(b.mean, idx), lo: pick(b.lo, idx), hi: pick(b.hi, idx) };
      final[m.key] = { ...result.stats[a].at(m.index, n - 1), t: result.ts[n - 1] };
    }
    return { info: compactInfo(result.infos[a]), ts: Float64Array.from(idx, (k) => result.ts[k]), series, final };
  }

  // ------------------------------------------------------------------ CSV ----
  function csvCell(v) {
    if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
    const s = typeof v === "number" ? String(+v.toPrecision(12)) : String(v);
    // Neutralize spreadsheet formula injection and quote when needed.
    const safe = /^[=+\-@\t\r]/.test(s) && typeof v !== "number" ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }
  const csvLine = (cells) => cells.map(csvCell).join(",");

  /** Single trajectories: one row per round (or checkpoint) per arm. */
  function trajectoryCSV(entries) {
    const lines = [];
    const header = ["arm", "t"];
    const first = entries[0].traj;
    const keys = first.layout.map((m) => m.key);
    const withRows = entries.every((e) => e.traj.keepRows);
    if (withRows) header.push("p1_action", "p2_action", "p1_payoff", "p2_payoff", "p1_feedback", "p2_feedback");
    lines.push(csvLine([...header, ...first.layout.map((m) => m.label)]));
    for (const { arm, traj } of entries) {
      const rowsByT = withRows ? new Map(traj.rows.map((r) => [r.t, r])) : null;
      for (let k = 0; k < traj.length; k++) {
        const t = traj.ts[k];
        const cells = [arm, t];
        if (withRows) {
          const r = rowsByT.get(t);
          cells.push(traj.info.names[0][r.actions[0]], traj.info.names[1][r.actions[1]], r.payoffs[0], r.payoffs[1], r.feedback[0], r.feedback[1]);
        }
        for (const key of keys) {
          const m = traj.layout.find((x) => x.key === key);
          cells.push(m ? traj.series[m.index][k] : null);
        }
        lines.push(csvLine(cells));
      }
    }
    return lines.join("\n") + "\n";
  }

  /** Monte Carlo: long format with pointwise mean and 95% CI; paired differences labelled "j - b". */
  function monteCarloCSV(result) {
    const lines = [csvLine(["series", "metric", "t", "n", "mean", "ci95_low", "ci95_high"])];
    result.arms.forEach((arm, a) => {
      result.layouts[a].forEach((m) => {
        for (let k = 0; k < result.ts.length; k++) {
          const r = result.stats[a].at(m.index, k);
          lines.push(csvLine([arm, m.label, result.ts[k], r.n, r.mean, r.lo, r.hi]));
        }
      });
    });
    result.pairs.forEach(([j, b], p) => {
      result.shared.forEach((key, s) => {
        const label = result.layouts[0].find((m) => m.key === key).label;
        for (let k = 0; k < result.ts.length; k++) {
          const r = result.diffStats[p].at(s, k);
          lines.push(csvLine([`${result.arms[j]} - ${result.arms[b]}`, label, result.ts[k], r.n, r.mean, r.lo, r.hi]));
        }
      });
    });
    return lines.join("\n") + "\n";
  }

  return {
    metricLayout, makeExtractor, checkpoints, Trajectory, SeriesStats, tCritical,
    runMonteCarlo, differenceBand, armBand, trajectoryCSV, monteCarloCSV, csvCell,
    compactInfo, thinIndices, snapshotTrajectory, snapshotMonteCarlo,
  };
});
