"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PK = require("../src/poker.js");

const close = (a, b, tol = 1e-12, msg) => assert.ok(Math.abs(a - b) <= tol, msg || `${a} ≉ ${b}`);
const strat = (game, key, player = 0) => PK.makeStrategy(game, key, player);
const dist = (r) => Object.fromEntries(r.outcomes.filter((o) => o.prob > 0).map((o) => [o.value, o.prob]));
function sameDist(r, expected) {
  const d = dist(r);
  assert.deepEqual(Object.keys(d).sort(), Object.keys(expected).sort());
  for (const k of Object.keys(expected)) close(d[k], expected[k], 1e-12, `P(${k})`);
}

function randomStrategy(game, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = strat(game, "uniform");
  out.probs.forEach((round) => Object.values(round).forEach((p) => { for (const k of Object.keys(p)) p[k] = rnd() < 0.15 ? Math.round(rnd()) : rnd(); }));
  return out;
}

test("Kuhn: Nash equilibrium value is −1/18 and no pure Player 1 deviation beats it", () => {
  const p2 = strat("kuhn", "nash", 1);
  close(PK.evaluate("kuhn", [strat("kuhn", "nash", 0), p2]).mean, -1 / 18);
  for (let mask = 0; mask < 64; mask++) {
    const p1 = strat("kuhn", "uniform");
    ["K", "Q", "J"].forEach((c, k) => { p1.probs[0][c].bet = (mask >> k) & 1; p1.probs[0][c].call = (mask >> (k + 3)) & 1; });
    assert.ok(PK.evaluate("kuhn", [p1, p2]).mean <= -1 / 18 + 1e-12, `mask ${mask}`);
  }
  for (const alpha of [0, 0.1, 1 / 6, 1 / 3]) {
    const p1 = { probs: PK.kuhnNash(0, alpha) };
    close(PK.evaluate("kuhn", [p1, p2]).mean, -1 / 18, 1e-12, `α = ${alpha}`);
    // No pure Player 2 deviation does better against any member of the family.
    for (let mask = 0; mask < 64; mask++) {
      const q = strat("kuhn", "uniform", 1);
      ["K", "Q", "J"].forEach((c, k) => { q.probs[0][c].bet = (mask >> k) & 1; q.probs[0][c].call = (mask >> (k + 3)) & 1; });
      assert.ok(PK.evaluate("kuhn", [p1, q]).mean >= -1 / 18 - 1e-12, `α = ${alpha}, mask ${mask}`);
    }
  }
});

test("Kuhn: α is detected, named and kept in storage", () => {
  const s = strat("kuhn", "nash", 0);
  assert.equal(s.alpha, 1 / 3);
  assert.equal(s.name, "Nash (α = 1/3)");
  assert.equal(PK.nashName(0.2), "Nash (α = 0.2)");
  close(PK.nashAlpha(PK.kuhnNash(0, 0.2)), 0.2);
  assert.equal(PK.nashAlpha(strat("kuhn", "uniform").probs), null);
  assert.equal(strat("kuhn", "nash", 1).alpha, undefined);
  // Stored α survives; legacy strategies without α are recognised from their probabilities.
  assert.equal(PK.normalizeStrategy("kuhn", JSON.parse(JSON.stringify({ ...s, alpha: 0.1 })), 0).alpha, 0.1);
  close(PK.normalizeStrategy("kuhn", { name: "Old", probs: PK.kuhnNash(0, 0.25) }, 0).alpha, 0.25);
  assert.equal(PK.normalizeStrategy("kuhn", { name: "x", probs: PK.kuhnNash(0, 0.25), alpha: null }, 0).alpha, 0.25);
  assert.equal(PK.normalizeStrategy("kuhn", s, 1).alpha, undefined);
  assert.equal(PK.normalizeStrategy("leduc", strat("leduc", "uniform"), 0).alpha, undefined);
});

test("Kuhn: hand-checked distributions", () => {
  const maniac = PK.evaluate("kuhn", [strat("kuhn", "maniac"), strat("kuhn", "maniac", 1)]);
  sameDist(maniac, { "-2": 0.5, 2: 0.5 });
  const folder = strat("kuhn", "station", 1);
  Object.values(folder.probs[0]).forEach((p) => { p.call = 0; });
  const r = PK.evaluate("kuhn", [strat("kuhn", "maniac"), folder]);
  sameDist(r, { 1: 1 });
  close(r.folds[1], 1);
});

test("Leduc: hand-checked distributions", () => {
  // Bet, raise, call in both rounds: always a showdown for 13; equal ranks split (probability 1/5).
  const both = PK.evaluate("leduc", [strat("leduc", "maniac"), strat("leduc", "maniac", 1)]);
  const d = dist(both);
  close(d[13], 0.4); close(d[-13], 0.4); close(d[0], 0.2); close(both.mean, 0);
  close(both.showdown, 1);
  // Nobody ever bets: showdown for the antes, symmetric, so the mean is 0.
  const passive = strat("leduc", "station");
  close(PK.evaluate("leduc", [passive, strat("leduc", "station", 1)]).mean, 0);
  // Player 2 folds to every bet.
  const folder = strat("leduc", "station", 1);
  folder.probs.forEach((round) => Object.values(round).forEach((p) => { p.call = 0; }));
  sameDist(PK.evaluate("leduc", [strat("leduc", "maniac"), folder]), { 1: 1 });
});

// Independent Leduc implementation: explicit action strings per round.
function referenceLeduc(s1, s2) {
  const deck = [0, 0, 1, 1, 2, 2], strategies = [s1, s2], sizes = [2, 4];
  const out = new Map();
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let k = 0; k < 6; k++) {
    if (i === j || i === k || j === k) continue;
    const cards = [deck[i], deck[j]], board = deck[k];
    const key = (p, r) => (r === 1 && cards[p] === board ? "pair" : "JQK"[cards[p]]);
    const rank = (p) => (cards[p] === board ? 10 : 0) + cards[p];
    const walk = (r, hist, paid, q) => {
      const p = hist.length % 2, x = strategies[p].probs[r][key(p, r)];
      const last = hist[hist.length - 1], aggressive = (hist.match(/[br]/g) || []).length;
      const moves = last === "b" || last === "r"
        ? [["r", aggressive < 2 ? x.raise : 0], ["c", (1 - (aggressive < 2 ? x.raise : 0)) * x.call], ["f", (1 - (aggressive < 2 ? x.raise : 0)) * (1 - x.call)]]
        : [["k", 1 - x.bet], ["b", x.bet]];
      for (const [m, w] of moves) {
        if (!(w > 0)) continue;
        const h = hist + m, np = paid.slice();
        if (m === "b" || m === "r") np[p] = paid[1 - p] + sizes[r];
        if (m === "c") np[p] = paid[1 - p];
        if (m === "f") { const v = p === 0 ? -paid[0] : paid[1]; out.set(v, (out.get(v) || 0) + q * w); continue; }
        if (h.endsWith("kk") || m === "c") {
          if (r === 0) { walk(1, "", np, q * w); continue; }
          const v = rank(0) > rank(1) ? np[1] : rank(0) < rank(1) ? -np[0] : 0;
          out.set(v, (out.get(v) || 0) + q * w);
          continue;
        }
        walk(r, h, np, q * w);
      }
    };
    walk(0, "", [1, 1], 1 / 120);
  }
  return out;
}

test("Leduc: exact evaluation matches an independent implementation", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s1 = randomStrategy("leduc", seed), s2 = randomStrategy("leduc", 1000 + seed);
    const got = PK.evaluate("leduc", [s1, s2]), ref = referenceLeduc(s1, s2);
    let total = 0;
    for (const o of got.outcomes) { close(o.prob, ref.get(o.value) || 0, 1e-12, `seed ${seed}, value ${o.value}`); total += o.prob; }
    close(total, 1, 1e-12);
    for (const v of ref.keys()) assert.ok(PK.GAMES.leduc.outcomes.includes(v), `unexpected outcome ${v}`);
    close(got.win + got.tie + got.lose, 1, 1e-12);
    close(got.showdown + got.folds[0] + got.folds[1], 1, 1e-12);
  }
});

test("game tree: probabilities are consistent and its leaves reproduce the exact distribution", () => {
  const cases = [
    ["kuhn", strat("kuhn", "nash", 0), strat("kuhn", "nash", 1)],
    ["kuhn", randomStrategy("kuhn", 7), randomStrategy("kuhn", 8)],
    ["leduc", randomStrategy("leduc", 3), randomStrategy("leduc", 4)],
    ["leduc", strat("leduc", "maniac"), strat("leduc", "tight", 1)],
  ];
  for (const [game, s1, s2] of cases) {
    const root = PK.gameTree(game, [s1, s2]);
    const mass = new Map(), ids = new Set();
    let leaves = 0;
    const visit = (node) => {
      assert.ok(!ids.has(node.id), `duplicate id ${node.id}`);
      ids.add(node.id);
      if (node.kind === "terminal") { leaves += 1; mass.set(node.payoff, (mass.get(node.payoff) || 0) + node.reach); return; }
      close(node.children.reduce((a, c) => a + c.p, 0), 1, 1e-12, `${game} ${node.id}: edge probabilities`);
      for (const c of node.children) { close(c.reach, node.reach * c.p, 1e-15); visit(c); }
    };
    visit(root);
    assert.equal(root.children.length, game === "kuhn" ? 6 : 9);
    if (game === "kuhn") assert.equal(leaves, 30);
    const r = PK.evaluate(game, [s1, s2]);
    for (const o of r.outcomes) close(mass.get(o.value) || 0, o.prob, 1e-12, `${game} P(${o.value})`);
  }
});

test("templates, normalization and payoff matrix", () => {
  for (const game of ["kuhn", "leduc"]) {
    for (const t of PK.templatesFor(game)) {
      for (const player of [0, 1]) {
        const s = PK.makeStrategy(game, t.key, player);
        assert.deepEqual(PK.normalizeStrategy(game, s), s, `${game} ${t.key}`);
      }
    }
  }
  assert.ok(!PK.templatesFor("leduc").some((t) => t.key === "nash"));
  const fixed = PK.normalizeStrategy("leduc", { name: "  x ", probs: [{ K: { bet: 7, call: "0.25" } }] });
  assert.equal(fixed.name, "x");
  assert.equal(fixed.probs[0].K.bet, 1);
  assert.equal(fixed.probs[0].K.call, 0.25);
  assert.equal(fixed.probs[1].pair.raise, 1 / 3);
  const m = PK.payoffMatrix("kuhn", [[strat("kuhn", "nash", 0), strat("kuhn", "maniac")], [strat("kuhn", "nash", 1)]]);
  assert.equal(m.length, 2); assert.equal(m[0].length, 1);
  close(m[0][0], -1 / 18);
});
