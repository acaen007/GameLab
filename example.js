// Headless example: compare the four preset deployments for UCB1 (Monte Carlo, paired CIs).
// Usage: node example.js [learner] [--binarize]   learner: ucb1 | ucbv | exp3 | thompson
"use strict";
const fs = require("node:fs");
const E = require("./src/engine.js");
const A = require("./src/analysis.js");

async function main() {
  const kind = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "ucb1";
  const exp = E.defaultExperiment();
  exp.players[0] = { ...E.defaultPlayer(kind), binarize: process.argv.includes("--binarize") };
  Object.assign(exp.sim, { horizon: 1000, repetitions: 100, switchRound: 500, seed: 2024 });

  const result = await A.runMonteCarlo(exp, { arms: E.ARM_KEYS, yieldFn: async () => {} });
  const k = result.ts.length - 1;
  const eps = exp.sim.epsilon;
  console.log(`P1 = ${kind}${exp.players[0].binarize ? " (binarized)" : ""}, T = ${exp.sim.horizon}, R = ${result.reps}, ε = ${eps}, N = ${exp.sim.switchRound}`);
  console.log(`Learner parameters: ${JSON.stringify(result.infos[0].learners[0].parameters)}`);
  const fmtCI = (r) => `${r.mean.toFixed(3)} [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`;
  for (const [a, arm] of result.arms.entries()) {
    const at = (key) => result.stats[a].at(result.layouts[a].find((m) => m.key === key).index, k);
    console.log(`${E.ARMS[arm].label.padEnd(42)} pseudo-regret ${fmtCI(at("pseudo0"))}  external regret ${fmtCI(at("ext0"))}  ` +
      `exploitability ${result.infos[a].candidates[1].map((c) => c.exploitability.toFixed(3)).join("/")}`);
  }
  for (let j = 1; j < result.arms.length; j++) {
    const d = A.differenceBand(result, j, 0, "pseudo0");
    console.log(`Δ pseudo-regret ${result.arms[j]} − S1: ${d.mean[k].toFixed(3)} [${d.lo[k].toFixed(3)}, ${d.hi[k].toFixed(3)}] (paired 95% CI)`);
  }
  fs.writeFileSync("example-results.csv", A.monteCarloCSV(result));
  console.log("Wrote example-results.csv");
}

main().catch((err) => { console.error(err.message); process.exit(1); });
