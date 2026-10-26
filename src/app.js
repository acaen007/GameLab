/* DOM interface. All user-provided text is rendered with textContent only. */
(function () {
  "use strict";
  const E = window.NFEngine, A = window.NFAnalysis, C = window.NFCharts, P = window.NFPresets;
  const $ = (id) => document.getElementById(id);

  const ARM_COLORS = { configured: "#2563eb", S1: "#2563eb", mixture: "#dc2626", mix_then_S1: "#16a34a", S1_then_mix: "#d97706" };
  // Keep in sync with .swatch.c0–c9 in styles.css.
  const SAVED_COLORS = ["#7c3aed", "#0891b2", "#db2777", "#65a30d", "#c2410c", "#0f766e", "#4f46e5", "#a16207", "#be123c", "#475569"];
  const TABS = [
    ["payoff", "Payoffs"], ["policy", "Action probabilities"], ["freq", "Frequencies"],
    ["state", "Learner state"], ["regret", "Regret"], ["compare", "Deployment differences"],
  ];

  const state = {
    exp: E.cloneExperiment(P.list[0].experiment),
    view: "setup",
    mode: "single",
    repIndex: 0,
    run: null,
    busy: null,
    tab: "payoff",
    plotPlayer: 0,
    plotArm: 0,
    baseline: 0,
    metric: "pseudo0",
    lastPlotRender: 0,
    saved: [],
    storageNote: "",
  };

  // ------------------------------------------------------------ helpers ----
  function el(tag, props = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else if (typeof v === "boolean") n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  function fmt(x, digits = 4) {
    if (x === null || x === undefined) return "—";
    if (typeof x === "string") return x;
    if (!Number.isFinite(x)) return "—";
    if (Math.abs(x) < 1e-12) return "0";
    const a = Math.abs(x);
    if (a >= 1e5 || a < 1e-4) return x.toExponential(3);
    return String(+x.toFixed(digits));
  }
  const short = (x) => (Number.isFinite(x) ? String(+x.toPrecision(6)) : "");

  function parseNum(text) {
    const s = String(text).trim();
    if (s === "") return NaN;
    const frac = /^(-?\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/.exec(s);
    if (frac) return Number(frac[1]) / Number(frac[2]);
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
  }
  const parseOptional = (text) => (String(text).trim() === "" ? null : parseNum(text));
  const parseIntOrNaN = (text) => { const x = parseNum(text); return Number.isInteger(x) ? x : NaN; };
  function parseList(text) {
    if (String(text).trim() === "") return null;
    return String(text).split(/[,\s]+/).filter(Boolean).map(parseNum);
  }

  const names = (i) => (i === 0 ? state.exp.game.rows : state.exp.game.cols);
  const K = (i) => names(i).length;
  const isLearner = (kind) => !E.KINDS[kind].fixed;
  const deployment = () => state.exp.sim.deployment;
  const signature = () => JSON.stringify(state.exp);
  const mixLabel = (mix, labels) => labels.map((n, a) => `${n} ${fmt(mix[a], 3)}`).filter((_, a) => mix[a] > 1e-12).join(", ");
  const isPreset = () => !E.validateGame(state.exp.game).length && E.isPresetGame(state.exp.game, state.exp.sim.epsilon);

  function solution() {
    if (E.validateGame(state.exp.game).length) return null;
    try { return E.solveZeroSum(state.exp.game.payoff); } catch (err) { return null; }
  }

  function download(filename, data, type) {
    const url = typeof data === "string" && data.startsWith("data:") ? data : URL.createObjectURL(new Blob([data], { type }));
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    if (!url.startsWith("data:")) setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function showErrors(list) {
    $("errors").replaceChildren(...list.map((m) => el("li", { text: m })));
  }

  function playerLabel(i, exp = state.exp, arm = exp.sim.deployment) {
    if (i === 1 && arm !== "configured") return E.ARMS[arm].label;
    const cfg = exp.players[i];
    const labels = i === 0 ? exp.game.rows : exp.game.cols;
    const base = E.KINDS[cfg.kind].label.replace(/ \(.*\)$/, "");
    if (cfg.kind === "pure") return `Always ${labels[cfg.action] ?? "?"}`;
    if (cfg.kind === "mixed") return `Mixed: ${mixLabel(cfg.mixture, labels) || "invalid"}`;
    if (!isLearner(cfg.kind)) return base;
    return `${base}${cfg.binarize ? ", binarized" : ""}, ${cfg.feedback === "full-information" ? "full info" : "reward-only"}`;
  }

  // ----------------------------------------------------- strategies ----
  /** Player i's per-round mixture when it plays a fixed strategy; null for learners. */
  function strategyMixture(i) {
    const n = K(i);
    if (i === 1 && deployment() !== "configured") return Array.from(E.armMixture(deployment(), 1, state.exp.sim.epsilon, state.exp.sim.switchRound));
    const cfg = state.exp.players[i];
    if (cfg.kind === "pure") return Array.from({ length: n }, (_, a) => (a === cfg.action ? 1 : 0));
    if (cfg.kind === "mixed") return cfg.mixture.slice();
    if (cfg.kind === "uniform") return new Array(n).fill(1 / n);
    if (cfg.kind === "minimax") { const sol = solution(); return sol ? Array.from(i === 0 ? sol.row : sol.col) : null; }
    if (cfg.kind === "pool") {
      // Ex-ante per-round mixture; the actual match commits to one pool member.
      const out = new Array(n).fill(0);
      cfg.pool.strategies.forEach((s, k) => s.forEach((x, a) => { out[a] += (cfg.pool.weights[k] || 0) * x; }));
      return out;
    }
    return null;
  }

  /** Editing p or q in the matrix turns that player into a fixed mixed strategy. */
  function editStrategy(i, a, input) {
    const cfg = state.exp.players[i];
    const x = parseNum(input.value);
    const scheduled = i === 1 && deployment() !== "configured";
    if (cfg.kind !== "mixed" || scheduled) {
      const current = strategyMixture(i) || new Array(K(i)).fill(1 / K(i));
      cfg.kind = "mixed";
      cfg.mixture = current.map((v) => +v.toPrecision(12));
      if (i === 1) state.exp.sim.deployment = "configured";
    }
    cfg.mixture[a] = x;
    input.classList.toggle("invalid", !(x >= 0));
    renderPlayer(i);
    changed();
  }

  // ---------------------------------------------------- shape changes ----
  function resizeMixture(m, n, removed) {
    let out = m.slice();
    if (removed !== undefined) out.splice(removed, 1);
    while (out.length < n) out.push(0);
    out = out.slice(0, n);
    const s = out.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0);
    return s > 0 ? out.map((x) => (Number.isFinite(x) ? x / s : 0)) : new Array(n).fill(1 / n);
  }

  function adaptPlayer(i, removed) {
    const cfg = state.exp.players[i];
    const n = K(i);
    if (removed !== undefined) {
      if (cfg.action === removed) cfg.action = 0;
      else if (cfg.action > removed) cfg.action -= 1;
    }
    if (cfg.action >= n) cfg.action = 0;
    cfg.mixture = cfg.mixture.length ? resizeMixture(cfg.mixture, n, removed) : new Array(n).fill(1 / n);
    cfg.pool.strategies = cfg.pool.strategies.map((s) => resizeMixture(s, n, removed));
    for (const key of ["exp3", "hedge"]) {
      const w = cfg[key].initialWeights;
      if (Array.isArray(w)) {
        const c = w.slice();
        if (removed !== undefined) c.splice(removed, 1);
        while (c.length < n) c.push(1);
        cfg[key].initialWeights = c.slice(0, n);
      }
    }
  }

  function uniqueName(list, base) {
    let k = list.length + 1;
    while (list.includes(`${base}${k}`)) k += 1;
    return `${base}${k}`;
  }

  function addAction(i) {
    const g = state.exp.game;
    if (i === 0) { g.rows.push(uniqueName(g.rows, "R")); g.payoff.push(new Array(g.cols.length).fill(0)); }
    else { g.cols.push(uniqueName(g.cols, "C")); g.payoff.forEach((r) => r.push(0)); }
    adaptPlayer(i);
    renderSetup();
  }

  function removeAction(i, k) {
    const g = state.exp.game;
    if (K(i) <= 1) return;
    if (i === 0) { g.rows.splice(k, 1); g.payoff.splice(k, 1); }
    else { g.cols.splice(k, 1); g.payoff.forEach((r) => r.splice(k, 1)); }
    adaptPlayer(i, k);
    renderSetup();
  }

  // ------------------------------------------------------ matrix editor ----
  function renderMatrix() {
    const g = state.exp.game;
    const table = $("matrix");
    const corner = el("th", { class: "corner" }, el("div", { class: "corner-label" },
      el("span", { class: "p2", text: "P2 →" }), el("br"), el("span", { class: "p1", text: "P1 ↓" })));
    const head = el("tr", {}, corner, ...g.cols.map((name, j) => el("th", { class: "col-head" }, headCell(1, j, name))),
      el("th", { class: "strat-head p1", title: "Player 1's strategy: probability of each row" }, "p"),
      el("th", { class: "exp-head", title: "Expected payoff of each row against q" }, "E[P1]"));
    const body = el("tbody");
    g.rows.forEach((name, i) => {
      const tr = el("tr", {}, el("th", { class: "row-head" }, headCell(0, i, name)));
      g.cols.forEach((_, j) => {
        const v = g.payoff[i][j];
        tr.append(el("td", { class: "cell" }, el("input", {
          type: "text", inputmode: "decimal", value: Number.isFinite(v) ? String(v) : "", "aria-label": `Payoff ${g.rows[i]} vs ${g.cols[j]}`,
          oninput: (e) => {
            const x = parseNum(e.target.value);
            g.payoff[i][j] = x;
            e.target.classList.toggle("invalid", !Number.isFinite(x));
            changed();
          },
        })));
      });
      tr.append(el("td", { class: "strat p1" }, strategyInput(0, i)), el("td", { class: "exp", id: `exp-row-${i}` }));
      body.append(tr);
    });
    const qRow = el("tr", { class: "q-row" }, el("th", { class: "strat-head p2", title: "Player 2's strategy: probability of each column" }, "q"));
    g.cols.forEach((_, j) => qRow.append(el("td", { class: "strat p2" }, strategyInput(1, j))));
    qRow.append(el("td", { colspan: "2" }));
    const eRow = el("tr", { class: "e-row" }, el("th", { class: "exp-head", title: "Expected payoff to Player 2 of each column against p" }, "E[P2]"));
    g.cols.forEach((_, j) => eRow.append(el("td", { class: "exp", id: `exp-col-${j}` })));
    eRow.append(el("td", { colspan: "2" }));
    body.append(qRow, eRow);
    table.replaceChildren(el("thead", {}, head), body);
  }

  function headCell(i, k, name) {
    const list = names(i);
    return el("div", { class: "headcell" },
      el("input", {
        type: "text", class: "name", value: name, maxlength: "24", "aria-label": `${i === 0 ? "Row" : "Column"} ${k + 1} name`,
        oninput: (e) => { list[k] = e.target.value; changed(); },
        onchange: () => renderPlayers(),
      }),
      el("button", { type: "button", class: "icon", title: `Remove ${name}`, "aria-label": `Remove ${name}`, disabled: list.length <= 1, onclick: () => removeAction(i, k) }, "×"));
  }

  function strategyInput(i, a) {
    return el("input", {
      type: "text", inputmode: "decimal", class: "strat", "data-player": String(i), "data-action": String(a),
      "aria-label": `${i === 0 ? "p" : "q"}[${names(i)[a]}]`,
      oninput: (e) => editStrategy(i, a, e.target),
    });
  }

  function refreshStrategies() {
    const g = state.exp.game;
    const okGame = !E.validateGame(g).length;
    const mixes = [strategyMixture(0), strategyMixture(1)];
    for (const i of [0, 1]) {
      const learner = !mixes[i];
      document.querySelectorAll(`#matrix input.strat[data-player="${i}"]`).forEach((input) => {
        const a = Number(input.dataset.action);
        input.disabled = learner;
        input.placeholder = learner ? "–" : "";
        input.title = learner ? `Player ${i + 1} is a learner (${E.KINDS[state.exp.players[i].kind].label}); choose a fixed strategy in its panel to set this` : "";
        if (document.activeElement !== input) {
          input.value = learner ? "" : short(mixes[i][a]);
          input.classList.toggle("invalid", !learner && !(mixes[i][a] >= 0));
        }
      });
    }
    const q = mixes[1] ? E.checkMixture(mixes[1], g.cols.length, "q") : { value: null };
    const p = mixes[0] ? E.checkMixture(mixes[0], g.rows.length, "p") : { value: null };
    const rowVals = okGame && q.value ? E.matVec(g.payoff, q.value) : null;
    const colVals = okGame && p.value ? E.vecMat(p.value, g.payoff).map((x) => -x) : null;
    const best = (vals, k) => !!vals && Math.abs(vals[k] - Math.max(...vals)) < 1e-12;
    g.rows.forEach((_, i) => { const c = $(`exp-row-${i}`); if (c) { c.textContent = rowVals ? fmt(rowVals[i]) : "—"; c.classList.toggle("best", best(rowVals, i)); } });
    g.cols.forEach((_, j) => { const c = $(`exp-col-${j}`); if (c) { c.textContent = colVals ? fmt(colVals[j]) : "—"; c.classList.toggle("best", best(colVals, j)); } });

    const learners = [0, 1].filter((i) => !mixes[i]);
    $("strategy-hint").textContent = "p and q are the strategies used in the simulation; typing a value makes that player play a fixed mix." +
      learners.map((i) => ` Player ${i + 1} is a learner (${E.KINDS[state.exp.players[i].kind].label.replace(/ \(.*\)$/, "")}), so ${i ? "q" : "p"} is chosen during play.`).join("");

    const sol = okGame ? solution() : null;
    const chip = (k, v, title) => el("div", { class: "eq-item", title }, el("span", { class: "k", text: k }), v);
    $("minimax").replaceChildren(...(sol
      ? [chip("Game value", fmt(sol.value, 6)), chip("Minimax p*", mixLabel(sol.row, g.rows)),
        chip("Minimax q*", mixLabel(sol.col, g.cols), "Equilibrium strategies need not be unique")]
      : [el("div", { class: "eq-item err", text: "Enter a number in every cell to solve the game." })]));
  }

  // ------------------------------------------------------- preset tools ----
  function renderPresetTools() {
    const box = $("preset-tools");
    const s = state.exp.sim;
    const status = el("span", { class: "sub", id: "preset-status" });
    box.replaceChildren(
      el("summary", {}, "Preset: deterministic vs mixed rewards ", status),
      el("p", { class: "hint", text: "A: [0.5+ε, 1, 0], B: [0.5−ε, 0, 1] against S1/S2/S3. Choose a preset deployment as Player 2's strategy, or use “Compare 4 deployments” on the Run page." }),
      el("div", { class: "row" },
        el("label", { class: "inline" }, "ε", el("input", {
          type: "text", class: "narrow", value: String(s.epsilon),
          oninput: (e) => { s.epsilon = parseNum(e.target.value); e.target.classList.toggle("invalid", !(s.epsilon > 0 && s.epsilon < 0.5)); changed(); },
        })),
        el("button", { type: "button", class: "small", onclick: applyPreset }, "Set matrix to preset")));
    refreshPresetStatus();
  }

  function refreshPresetStatus() {
    const s = $("preset-status");
    if (s) s.textContent = isPreset() ? `— current matrix (ε = ${state.exp.sim.epsilon})` : "";
  }

  function applyPreset() {
    const eps = state.exp.sim.epsilon;
    if (!(eps > 0 && eps < 0.5)) { $("setup-errors").replaceChildren(el("li", { text: "Preset: ε must satisfy 0 < ε < 0.5." })); return; }
    state.exp.game = E.presetGame(eps);
    for (const i of [0, 1]) adaptPlayer(i);
    const p2 = state.exp.players[1];
    if (p2.kind === "mixed") p2.mixture = [0, 0.5 + eps, 0.5 - eps];
    renderSetup();
  }

  // ------------------------------------------------------------ players ----
  function renderPlayers() { renderPlayer(0); renderPlayer(1); refreshFacts(); }

  function field(label, control, title) {
    return el("label", { class: "field", title }, label, control);
  }

  function textInput(value, onValue, opts = {}) {
    return el("input", {
      type: "text", value: value === null || value === undefined || (typeof value === "number" && Number.isNaN(value)) ? "" : String(value),
      placeholder: opts.placeholder, inputmode: opts.inputmode || "decimal",
      oninput: (e) => { onValue(e.target.value, e.target); changed(); },
    });
  }

  function mixtureEditor(values, labels) {
    const total = el("span", { class: "sub" });
    const updateTotal = () => { total.textContent = `sum ${fmt(values.reduce((x, y) => x + (Number.isFinite(y) ? y : NaN), 0), 6)}`; };
    updateTotal();
    return el("div", { class: "mixture" },
      ...labels.map((name, a) => el("label", {}, name, el("input", {
        type: "text", inputmode: "decimal", value: short(values[a]),
        oninput: (e) => {
          values[a] = parseNum(e.target.value);
          e.target.classList.toggle("invalid", !(values[a] >= 0));
          updateTotal(); changed();
        },
      }))),
      total);
  }

  function kindSelect(i) {
    const cfg = state.exp.players[i];
    const sel = el("select", {
      "aria-label": `Player ${i + 1} strategy`,
      onchange: (e) => {
        const v = e.target.value;
        if (v.startsWith("deploy:")) { state.exp.sim.deployment = v.slice(7); renderPlayer(i); changed(); return; }
        if (i === 1) state.exp.sim.deployment = "configured";
        cfg.kind = v;
        if (v === "mixed" && cfg.mixture.length !== K(i)) cfg.mixture = new Array(K(i)).fill(1 / K(i));
        if (v === "pool" && !cfg.pool.strategies.length) {
          cfg.pool = { strategies: names(i).map((_, a) => names(i).map((__, b) => (a === b ? 1 : 0))), weights: names(i).map(() => 1 / K(i)) };
        }
        if (v === "hedge") cfg.feedback = "full-information";
        renderPlayer(i); changed();
      },
    });
    for (const group of ["Fixed strategies", "Learning algorithms"]) {
      const og = el("optgroup", { label: group });
      for (const [k, meta] of Object.entries(E.KINDS)) if (meta.group === group) og.append(el("option", { value: k, text: meta.label }));
      sel.append(og);
    }
    if (i === 1 && (isPreset() || deployment() !== "configured")) {
      sel.append(el("optgroup", { label: "Preset deployments" }, ...E.ARM_KEYS.map((k) => el("option", { value: `deploy:${k}`, text: E.ARMS[k].label }))));
    }
    sel.value = i === 1 && deployment() !== "configured" ? `deploy:${deployment()}` : cfg.kind;
    return sel;
  }

  function renderPlayer(i) {
    const cfg = state.exp.players[i];
    const labels = names(i);
    const card = $(`player-${i}`);
    const scheduled = i === 1 && deployment() !== "configured";
    const children = [
      el("div", { class: "card-head" }, el("h2", { class: "player-title" }, el("span", { class: "dot" }), `Player ${i + 1}`),
        el("span", { class: "sub", text: i === 0 ? "chooses rows" : "chooses columns" })),
      field("Strategy", kindSelect(i)),
    ];
    if (scheduled) {
      const arm = deployment();
      const text = arm.includes("then")
        ? `Switches after round N = ${state.exp.sim.switchRound} (set N on the Run page).`
        : "Same mixture every round.";
      children.push(el("p", { class: "desc", text: `Oblivious schedule from the preset. ${text}` }));
      children.push(el("div", { class: "facts", id: `facts-${i}` }));
      card.replaceChildren(...children);
      return;
    }
    children.push(el("p", { class: "desc", text: E.KINDS[cfg.kind].description }));

    const fields = el("div", { class: "fields" });
    const extra = [];
    switch (cfg.kind) {
      case "pure": {
        const sel = el("select", { onchange: (e) => { cfg.action = Number(e.target.value); changed(); } },
          ...labels.map((n, a) => el("option", { value: String(a), text: n })));
        sel.value = String(cfg.action);
        fields.append(field("Action", sel));
        break;
      }
      case "mixed":
        extra.push(el("div", { class: "field" }, "Probabilities (drawn independently each round)", mixtureEditor(cfg.mixture, labels)));
        break;
      case "pool":
        extra.push(poolEditor(i));
        break;
      case "ucb1":
      case "ucbv": {
        const p = cfg.kind === "ucb1" ? cfg.ucb : cfg.ucbv;
        const order = el("select", { onchange: (e) => { p.initOrder = e.target.value; changed(); } },
          el("option", { value: "random", text: "each once, random order" }), el("option", { value: "sequential", text: "each once, index order" }));
        order.value = p.initOrder;
        if (cfg.kind === "ucb1") fields.append(field("Exploration c", textInput(p.c, (v) => { p.c = parseNum(v); })));
        else {
          fields.append(
            field("Exploration ζ", textInput(p.zeta, (v) => { p.zeta = parseNum(v); }), "E = ζ ln t; ζ > 1 gives logarithmic regret"),
            field("Constant c", textInput(p.c, (v) => { p.c = parseNum(v); }), "Weight of the 3c E / n term"));
        }
        fields.append(field("Initialization", order));
        break;
      }
      case "exp3":
        fields.append(
          field("Exploration γ", textInput(cfg.exp3.gamma, (v) => { cfg.exp3.gamma = parseOptional(v); }, { placeholder: `auto ${fmt(E.defaultExp3Gamma(K(i), state.exp.sim.horizon))}` }), "Blank: min(1, √(K ln K / ((e−1)T)))"),
          field("Initial weights", textInput(cfg.exp3.initialWeights ? cfg.exp3.initialWeights.join(", ") : "", (v) => { cfg.exp3.initialWeights = parseList(v); }, { placeholder: "uniform", inputmode: "text" })));
        break;
      case "hedge":
        fields.append(
          field("Learning rate η", textInput(cfg.hedge.eta, (v) => { cfg.hedge.eta = parseOptional(v); }, { placeholder: `auto ${fmt(E.defaultHedgeEta(K(i), state.exp.sim.horizon))}` }), "Blank: √(8 ln K / T)"),
          field("Initial weights", textInput(cfg.hedge.initialWeights ? cfg.hedge.initialWeights.join(", ") : "", (v) => { cfg.hedge.initialWeights = parseList(v); }, { placeholder: "uniform", inputmode: "text" })));
        break;
      case "thompson":
        fields.append(
          field("Prior α", textInput(cfg.thompson.alpha, (v) => { cfg.thompson.alpha = parseNum(v); })),
          field("Prior β", textInput(cfg.thompson.beta, (v) => { cfg.thompson.beta = parseNum(v); })));
        break;
      default:
    }
    if (isLearner(cfg.kind)) {
      const fb = el("select", { onchange: (e) => { cfg.feedback = e.target.value; changed(); } },
        el("option", { value: "reward-only", text: "Reward only" }), el("option", { value: "full-information", text: "Full information" }));
      fb.value = cfg.feedback;
      fields.append(field("Feedback", fb, "Reward only: own action and reward. Full information: also the opponent's action and every action's counterfactual reward."));
    }
    if (cfg.kind !== "pure" && cfg.kind !== "minimax") {
      fields.append(field("Seed", textInput(cfg.seed, (v) => { cfg.seed = String(v).trim() === "" ? null : parseIntOrNaN(v); }, { placeholder: "master", inputmode: "numeric" }), "Blank: use the master seed"));
    }
    if (fields.children.length) children.push(fields);
    children.push(...extra);
    if (isLearner(cfg.kind)) {
      children.push(el("label", { class: "check", title: "Feed Bernoulli(r~) instead of r~ (one uniform per action per round)." },
        el("input", { type: "checkbox", checked: cfg.binarize, onchange: (e) => { cfg.binarize = e.target.checked; changed(); } }),
        "Binarize rewards"));
    }
    children.push(el("div", { class: "facts", id: `facts-${i}` }));
    card.replaceChildren(...children);
  }

  function poolEditor(i) {
    const cfg = state.exp.players[i];
    const labels = names(i);
    const wrap = el("div", { class: "field" }, "Pool (one strategy drawn secretly per match, by weight)");
    cfg.pool.strategies.forEach((s, k) => {
      wrap.append(el("div", { class: "pool-item" },
        el("label", { class: "field" }, "Weight", el("input", {
          type: "text", class: "weight", value: short(cfg.pool.weights[k]),
          oninput: (e) => { cfg.pool.weights[k] = parseNum(e.target.value); changed(); },
        })),
        mixtureEditor(s, labels),
        el("button", {
          type: "button", class: "icon", title: "Remove strategy", disabled: cfg.pool.strategies.length <= 1,
          onclick: () => { cfg.pool.strategies.splice(k, 1); cfg.pool.weights.splice(k, 1); renderPlayer(i); changed(); },
        }, "×")));
    });
    wrap.append(el("div", { class: "button-row" }, el("button", {
      type: "button", class: "small",
      onclick: () => { cfg.pool.strategies.push(new Array(K(i)).fill(1 / K(i))); cfg.pool.weights.push(0); renderPlayer(i); changed(); },
    }, "+ Add strategy")));
    return wrap;
  }

  function refreshFacts() {
    const sol = solution();
    for (const i of [0, 1]) {
      const box = $(`facts-${i}`);
      if (!box) continue;
      const cfg = state.exp.players[i];
      const dl = el("dl");
      const scheduled = i === 1 && deployment() !== "configured";
      const errs = scheduled ? [] : E.validatePlayer(cfg, K(i), `Player ${i + 1}`);
      const mix = strategyMixture(i);
      if (mix && !errs.length) {
        const only = mix.findIndex((x) => Math.abs(x - 1) < 1e-12);
        dl.append(el("dt", { text: "Plays" }), el("dd", { text: only >= 0 ? `always ${names(i)[only]}` : mixLabel(mix, names(i)) }));
      }
      if (sol) dl.append(el("dt", { text: "Rewards seen" }), el("dd", { text: E.makeNormalizer(E.playerTable(state.exp.game, i)).describe }));
      if (!scheduled && !errs.length && isLearner(cfg.kind) && Number.isInteger(state.exp.sim.horizon) && state.exp.sim.horizon > 0) {
        const L = E.createLearner(cfg, K(i), { rng: { choice: new E.Stream("x"), binarize: new E.Stream("y"), pool: new E.Stream("z"), thompsonKey: "w" }, horizon: state.exp.sim.horizon, minimax: null });
        const params = L.parameters().map(([k, v, note]) => `${k} = ${fmt(v, 5)}${note ? ` (${note})` : ""}`).join("; ");
        dl.append(el("dt", { text: "Parameters" }), el("dd", { text: params }));
      }
      if (sol && !errs.length) {
        let cands = [];
        try { cands = E.stationaryCandidates(state.exp, i, sol, i === 1 ? deployment() : "configured"); } catch (err) { cands = []; }
        if (cands.length) dl.append(el("dt", { text: "Exploitability" }), el("dd", { text: cands.map((c) => (cands.length > 1 ? `${c.label}: ${fmt(c.exploitability, 6)}` : fmt(c.exploitability, 6))).join("; ") }));
      }
      for (const e of errs) dl.append(el("dt", { class: "err", text: "Error" }), el("dd", { class: "err", text: e.replace(/^Player \d: /, "") }));
      box.replaceChildren(dl);
    }
  }

  // ------------------------------------------------------- sim controls ----
  function bindSimFields() {
    const s = state.exp.sim;
    const bind = (id, get, set) => {
      const input = $(id);
      input.value = String(get());
      input.oninput = () => { set(parseIntOrNaN(input.value)); input.classList.toggle("invalid", !Number.isFinite(get())); changed(); };
    };
    bind("sim-horizon", () => s.horizon, (v) => { s.horizon = v; });
    bind("sim-reps", () => s.repetitions, (v) => { s.repetitions = v; });
    bind("sim-seed", () => s.seed, (v) => { s.seed = v; });
    bind("sim-window", () => s.rollingWindow, (v) => { s.rollingWindow = v; });
    bind("sim-switch", () => s.switchRound, (v) => { s.switchRound = v; });
    bind("sim-rep-index", () => state.repIndex, (v) => { state.repIndex = v; });
  }

  const speedValue = () => Math.round(Math.pow(10, (Number($("speed").value) / 100) * 3.3));

  function currentErrors(arms) {
    const errs = E.validateExperiment(state.exp, { arms: arms || [deployment()] });
    if (!(Number.isInteger(state.repIndex) && state.repIndex >= 0)) errs.push("Simulation: repetition index must be an integer ≥ 0.");
    return errs;
  }

  function updateControls() {
    const run = state.run;
    const busy = !!state.busy;
    const single = run && run.kind === "single" ? run : null;
    const stale = run && run.signature !== signature();
    const canStart = !currentErrors().length;
    const status = single ? single.status : null;
    const resumable = single && !stale && status === "paused" && !single.match.done;
    const playing = status === "playing" || (busy && state.busy.kind === "fast");
    const play = $("btn-play");
    play.textContent = resumable ? "▶ Resume" : "▶ Play";
    play.hidden = playing;
    $("btn-pause").hidden = !playing;
    play.disabled = busy || status === "playing" || (!resumable && !canStart);
    $("btn-pause").disabled = !(status === "playing" || (busy && state.busy.kind === "fast"));
    $("btn-step").disabled = busy || status === "playing" || (!resumable && !canStart);
    $("btn-fast").disabled = busy || (!resumable && !canStart);
    $("btn-run-mc").disabled = busy || !canStart;
    const compareErrs = currentErrors(E.ARM_KEYS);
    $("btn-compare").disabled = busy || status === "playing" || compareErrs.length > 0;
    $("btn-compare").title = compareErrs.length ? compareErrs[0] : "Run the four preset Player 2 deployments with common random numbers";
    $("btn-cancel").hidden = !(busy && state.busy.kind !== "fast");
    const preset = isPreset();
    $("btn-compare").hidden = !preset;
    $("switch-field").hidden = !preset;
    $("empty-compare").hidden = !preset;
    $("stale").hidden = !(run && stale);
    $("speed-label").textContent = `${speedValue()} rounds/s`;
    $("export-csv").disabled = !run;
    $("export-png").disabled = !run && !savedViews().length;
  }

  function renderConfigSummary() {
    const g = state.exp.game;
    const gameText = isPreset() ? `preset game, ε = ${state.exp.sim.epsilon}` : `${g.rows.length}×${g.cols.length} game`;
    $("config-summary").replaceChildren(
      el("span", { class: "who" }, el("span", { class: "dot p1" }), "P1"), playerLabel(0),
      el("span", { class: "vs", text: "vs" }),
      el("span", { class: "who" }, el("span", { class: "dot p2" }), "P2"), playerLabel(1),
      el("span", { class: "sub", text: `· ${gameText}` }));
  }

  function changed() {
    refreshStrategies();
    refreshFacts();
    refreshPresetStatus();
    const errs = currentErrors();
    showErrors(errs);
    $("setup-errors").replaceChildren(...errs.map((m) => el("li", { text: m })));
    $("setup-ok").hidden = errs.length > 0;
    renderConfigSummary();
    if (!state.run) renderLiveMatrix();
    updateControls();
  }

  function renderSetup() {
    renderMatrix();
    renderPresetTools();
    renderPlayers();
    changed();
  }

  function renderAll() {
    renderSetup();
    bindSimFields();
    renderResults();
  }

  function setView(view) {
    state.view = view;
    for (const v of ["setup", "run", "saved"]) {
      $(`view-${v}`).hidden = view !== v;
      $(`nav-${v}`).setAttribute("aria-selected", String(view === v));
    }
    if (view === "run") { bindSimFields(); renderResults(); }
    if (view === "saved") renderSaved();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------- running ----
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function newSingleRun() {
    const exp = E.cloneExperiment(state.exp);
    const match = E.createMatch(exp, { arm: exp.sim.deployment, repetition: state.repIndex });
    state.run = {
      kind: "single", exp, signature: signature(), match, arm: exp.sim.deployment, rep: state.repIndex, status: "paused", budget: 1,
      traj: new A.Trajectory(match.info, exp.sim.horizon, exp.sim.rollingWindow), last: null,
    };
    state.plotArm = 0;
    renderLiveMatrix();
    return state.run;
  }

  function ensureSingleRun() {
    const run = state.run;
    if (run && run.kind === "single" && run.signature === signature() && !run.match.done) return run;
    return newSingleRun();
  }

  function stepSingle(run) {
    const rec = run.match.step();
    if (!rec) return;
    run.traj.push(rec);
    run.last = rec;
  }

  function guard(fn) {
    return (...args) => {
      try { return fn(...args); } catch (err) {
        showErrors(err.errors || [err.message]);
        state.busy = null;
        if (state.run && state.run.status === "playing") state.run.status = "paused";
        updateControls();
        return undefined;
      }
    };
  }

  const play = guard(() => {
    const run = ensureSingleRun();
    run.status = "playing";
    run.lastTs = null;
    run.budget = Math.max(run.budget, 1);
    requestAnimationFrame(playFrame);
    updateControls();
  });

  function playFrame(ts) {
    const run = state.run;
    if (!run || run.kind !== "single" || run.status !== "playing") return;
    const dt = run.lastTs === null ? 0 : Math.min(0.25, (ts - run.lastTs) / 1000);
    run.lastTs = ts;
    run.budget += speedValue() * dt;
    let n = Math.floor(run.budget);
    run.budget -= n;
    const t0 = performance.now();
    while (n > 0 && !run.match.done && performance.now() - t0 < 14) { stepSingle(run); n -= 1; }
    if (n > 0) run.budget = 0;
    if (run.match.done) { run.status = "done"; saveRun(run); }
    renderProgress();
    renderRound();
    if (run.status !== "playing" || ts - state.lastPlotRender > 150) { state.lastPlotRender = ts; renderPlots(); renderSummary(); }
    updateControls();
    if (run.status === "playing") requestAnimationFrame(playFrame);
  }

  function pause() {
    if (state.busy && state.busy.kind === "fast") state.busy.cancel = true;
    if (state.run && state.run.status === "playing") state.run.status = "paused";
    renderResults();
  }

  const step = guard(() => {
    const run = ensureSingleRun();
    run.status = "paused";
    stepSingle(run);
    if (run.match.done) { run.status = "done"; saveRun(run); }
    renderResults();
  });

  const fast = guard(() => { runFast(ensureSingleRun()); });

  async function runFast(run) {
    run.status = "fast";
    const busy = { kind: "fast", cancel: false };
    state.busy = busy;
    updateControls();
    while (!run.match.done && !busy.cancel) {
      const t0 = performance.now();
      while (!run.match.done && performance.now() - t0 < 30) for (let k = 0; k < 64 && !run.match.done; k++) stepSingle(run);
      renderProgress();
      await nextTick();
    }
    run.status = run.match.done ? "done" : "paused";
    if (run.match.done) saveRun(run);
    if (state.busy === busy) state.busy = null;
    if (state.run === run) renderResults();
  }

  async function startMonteCarlo(arms) {
    const errs = currentErrors(arms);
    if (errs.length) { showErrors(errs); return; }
    if (state.run && state.run.status === "playing") state.run.status = "paused";
    const busy = { kind: "mc", cancel: false };
    state.busy = busy;
    const sig = signature();
    updateControls();
    try {
      const result = await A.runMonteCarlo(state.exp, {
        arms,
        isCancelled: () => busy.cancel,
        onProgress: ({ done, total, reps }) => {
          $("progress").value = done / total;
          $("progress-label").textContent = `${reps} of ${state.exp.sim.repetitions} repetitions · ${Math.round((100 * done) / total)}%`;
        },
      });
      if (state.busy !== busy) return; // reset while running: discard
      if (result.reps === 0) { state.busy = null; $("progress-label").textContent = "Cancelled before any repetition finished."; updateControls(); return; }
      state.run = { kind: "mc", signature: sig, exp: result.exp, result, arms };
      saveRun(state.run);
      state.plotArm = 0;
      state.baseline = Math.min(state.baseline, arms.length - 1);
      if (arms.length > 1) state.tab = "compare";
    } catch (err) {
      showErrors(err.errors || [err.message]);
    }
    state.busy = null;
    renderLiveMatrix();
    renderTabs();
    renderResults();
  }

  async function startSingleCompare() {
    const errs = currentErrors(E.ARM_KEYS);
    if (errs.length) { showErrors(errs); return; }
    if (state.run && state.run.status === "playing") state.run.status = "paused";
    const busy = { kind: "compare", cancel: false };
    state.busy = busy;
    const exp = E.cloneExperiment(state.exp);
    const sig = signature();
    const rep = state.repIndex;
    updateControls();
    const trajs = [];
    let done = 0;
    const total = E.ARM_KEYS.length * exp.sim.horizon;
    for (const arm of E.ARM_KEYS) {
      const match = E.createMatch(exp, { arm, repetition: rep });
      const traj = new A.Trajectory(match.info, exp.sim.horizon, exp.sim.rollingWindow);
      while (!match.done) {
        const t0 = performance.now();
        while (!match.done && performance.now() - t0 < 30) { traj.push(match.step()); done += 1; }
        $("progress").value = done / total;
        $("progress-label").textContent = `${E.ARMS[arm].short}: round ${match.t} of ${exp.sim.horizon}`;
        await nextTick();
        if (busy.cancel) {
          if (state.busy === busy) { state.busy = null; $("progress-label").textContent = "Comparison cancelled."; }
          updateControls();
          return;
        }
      }
      trajs.push(traj);
    }
    state.run = { kind: "singleCompare", signature: sig, exp, rep, arms: E.ARM_KEYS.slice(), trajs };
    saveRun(state.run);
    state.busy = null;
    state.plotArm = 0;
    state.tab = "compare";
    $("progress-label").textContent = "Comparison finished (one paired trajectory per deployment).";
    renderLiveMatrix();
    renderTabs();
    renderResults();
  }

  function startCompare() {
    if (state.busy) return;
    if (state.mode === "mc") startMonteCarlo(E.ARM_KEYS.slice());
    else startSingleCompare().catch((err) => { state.busy = null; showErrors(err.errors || [err.message]); updateControls(); });
  }

  function cancel() { if (state.busy) state.busy.cancel = true; }

  function reset() {
    if (state.busy) state.busy.cancel = true;
    state.run = null;
    state.busy = null;
    $("progress").value = 0;
    $("progress-label").textContent = "";
    renderLiveMatrix();
    renderResults();
  }

  // ------------------------------------------------------------- views ----
  function armName(arm) { return arm === "configured" ? "Current run" : E.ARMS[arm].short; }

  /** Views of the current run: one per deployment. */
  function runViews() {
    const run = state.run;
    if (!run) return [];
    if (run.kind === "single" || run.kind === "singleCompare") {
      const list = run.kind === "single" ? [{ arm: run.arm, traj: run.traj }] : run.arms.map((arm, a) => ({ arm, traj: run.trajs[a] }));
      return list.map(({ arm, traj }) => ({
        arm, name: armName(arm), color: ARM_COLORS[arm], info: traj.info, band: false, exp: run.exp, n: 1,
        series: (key) => { const s = traj.get(key); return s && s.ts.length ? { xs: s.ts, ys: s.ys } : null; },
        final: (key) => {
          const s = traj.get(key);
          return s && s.ys.length ? { mean: s.ys[s.ys.length - 1], n: 1, t: s.ts[s.ts.length - 1] } : null;
        },
      }));
    }
    const r = run.result;
    return r.arms.map((arm, a) => ({
      arm, name: armName(arm), color: ARM_COLORS[arm], info: r.infos[a], band: true, exp: r.exp, n: r.reps,
      series: (key) => { const b = A.armBand(r, a, key); return b ? { xs: r.ts, ys: b.mean, lo: b.lo, hi: b.hi } : null; },
      final: (key) => {
        const m = r.layouts[a].find((x) => x.key === key);
        return m ? { ...r.stats[a].at(m.index, r.ts.length - 1), t: r.ts[r.ts.length - 1] } : null;
      },
    }));
  }

  /** Saved runs ticked for the charts, except copies of the current run. */
  function savedViews() {
    const own = (state.run && state.run.savedIds) || [];
    return state.saved.filter((e) => e.visible && !own.includes(e.id)).map((e) => ({
      arm: e.arm, name: savedLabel(e), color: savedColor(e), info: e.data.info, band: e.kind === "mc", exp: e.exp, n: e.reps || 1, saved: e,
      series: (key) => { const s = e.data.series[key]; return s ? { xs: e.data.ts, ys: s.ys, lo: s.lo, hi: s.hi } : null; },
      final: (key) => e.data.final[key] || null,
    }));
  }

  const views = () => [...runViews(), ...savedViews()];

  function differenceSeries(j, b, key) {
    const run = state.run;
    if (run.kind === "mc") {
      const band = A.differenceBand(run.result, j, b, key);
      return band ? { xs: run.result.ts, ys: band.mean, lo: band.lo, hi: band.hi } : null;
    }
    if (run.kind === "singleCompare") {
      const x = run.trajs[j].get(key), y = run.trajs[b].get(key);
      if (!x || !y) return null;
      return { xs: x.ts, ys: Float64Array.from(x.ys, (v, k) => v - y.ys[k]) };
    }
    return null;
  }

  function sharedMetrics() {
    const vs = runViews();
    if (!vs.length) return [];
    const layouts = vs.map((v) => A.metricLayout(v.info));
    return layouts[0].filter((m) => layouts.every((L) => L.some((x) => x.key === m.key)));
  }

  // -------------------------------------------------------------- plots ----
  function renderTabs() {
    const multi = runViews().length > 1;
    if (!multi && state.tab === "compare") state.tab = "payoff";
    $("tabs").replaceChildren(...TABS.filter(([id]) => id !== "compare" || multi).map(([id, label]) => el("button", {
      type: "button", role: "tab", "aria-selected": String(state.tab === id),
      onclick: () => { state.tab = id; renderTabs(); renderPlots(); },
    }, label)));
  }

  function renderToolbar(vs, rvs) {
    const tab = state.tab;
    const multi = rvs.length > 1;
    $("ctl-player").hidden = tab === "compare";
    $("plot-player").value = String(state.plotPlayer);
    $("ctl-arm").hidden = !(vs.length > 1 && ["policy", "freq", "state"].includes(tab));
    $("ctl-arm-label").textContent = vs.some((v) => v.saved) ? "Run" : "Deployment";
    $("ctl-baseline").hidden = !(multi && tab === "compare");
    $("ctl-metric").hidden = !(multi && tab === "compare");
    const armSel = $("plot-arm"), baseSel = $("plot-baseline");
    const option = (v, a) => el("option", { value: String(a), text: v.saved || v.arm === "configured" ? v.name : E.ARMS[v.arm].label });
    armSel.replaceChildren(...vs.map(option));
    baseSel.replaceChildren(...rvs.map(option));
    state.plotArm = Math.min(state.plotArm, Math.max(0, vs.length - 1));
    state.baseline = Math.min(state.baseline, Math.max(0, rvs.length - 1));
    armSel.value = String(state.plotArm);
    baseSel.value = String(state.baseline);
    const metrics = multi ? sharedMetrics() : [];
    if (metrics.length && !metrics.some((m) => m.key === state.metric)) state.metric = metrics.some((m) => m.key === "pseudo0") ? "pseudo0" : "cum0";
    $("plot-metric").replaceChildren(...metrics.map((m) => el("option", { value: m.key, text: m.label })));
    $("plot-metric").value = state.metric;
  }

  function xLabel(vs) {
    const Ts = new Set(vs.map((v) => v.exp.sim.horizon));
    return Ts.size === 1 ? `round t (horizon T = ${[...Ts][0]})` : "round t";
  }

  function switchLines(vs) {
    const Ns = new Set(vs.filter((v) => v.arm === "mix_then_S1" || v.arm === "S1_then_mix").map((v) => v.exp.sim.switchRound));
    return [...Ns].map((N) => ({ x: N + 0.5, label: `switch at N = ${N}` }));
  }

  function chartFromViews(vs, key, title, extra = {}) {
    const series = [], used = [];
    for (const v of vs) {
      const s = v.series(key);
      if (s) { series.push({ label: v.name, color: v.color, front: !v.saved, ...s }); used.push(v); }
    }
    const ns = [...new Set(used.filter((v) => v.band).map((v) => v.n))];
    const suffix = ns.length ? ` · mean ± 95% CI${ns.length === 1 ? ` (n = ${ns[0]})` : ""}` : "";
    return { title: title + suffix, series, xLabel: xLabel(used.length ? used : vs), vlines: switchLines(used), ...extra };
  }

  function actionChart(v, prefix, i, title, extra = {}) {
    const labels = v.info.names[i];
    const series = [];
    labels.forEach((n, a) => {
      const s = v.series(`${prefix}${i}_${a}`);
      if (s) series.push({ label: n, color: C.PALETTE[a % C.PALETTE.length], ...s });
    });
    const suffix = v.band ? ` · mean ± 95% CI (n = ${v.n})` : "";
    return { title: `${title} — ${v.name}${suffix}`, series, xLabel: xLabel([v]), vlines: switchLines([v]), ...extra };
  }

  /** Game value and best-response lines, drawn only when every plotted run agrees on them. */
  function referenceLines(vs, i) {
    const lines = [];
    const values = new Set(vs.map((v) => +(i === 0 ? v.info.solution.value : -v.info.solution.value).toPrecision(10)));
    if (values.size === 1) { const y = [...values][0]; lines.push({ y, label: `game value ${fmt(y)}`, color: "#6b7280" }); }
    const best = new Set(vs.filter((v) => v.info.benchmarks[i].applies).map((v) => +Math.max(...v.info.benchmarks[i].vector).toPrecision(10)));
    if (best.size === 1) lines.push({ y: [...best][0], label: "best response", color: "#15803d" });
    return lines;
  }

  function plotSpecs() {
    const vs = views(), rvs = runViews();
    renderToolbar(vs, rvs);
    const note = $("plot-note");
    note.textContent = "";
    if (!vs.length) return [{ title: "No results yet", series: [], emptyText: "Press Play, Step, Run to end, or Run Monte Carlo." }];
    const i = state.plotPlayer;
    const Pn = `P${i + 1}`;
    const refLines = referenceLines(vs, i);
    const Ws = new Set(vs.map((x) => x.exp.sim.rollingWindow));
    const rollTitle = `${Pn} rolling payoff${Ws.size === 1 ? ` (last ${[...Ws][0]} rounds)` : ""}`;
    const v = vs[state.plotArm] || vs[0];

    switch (state.tab) {
      case "payoff":
        return [
          chartFromViews(vs, `cum${i}`, `${Pn} cumulative payoff`),
          chartFromViews(vs, `roll${i}`, rollTitle, { hlines: refLines }),
        ];
      case "policy":
        if (v.info.learners[i].kind === "thompson") note.textContent = "Thompson sampling: probability that each action has the largest posterior draw.";
        return [actionChart(v, "pol", i, `${Pn} action probabilities`, { yMin: 0, yMax: 1 })];
      case "freq":
        return [actionChart(v, "freq", i, `${Pn} empirical action frequencies`, { yMin: 0, yMax: 1 })];
      case "state": {
        const L = v.info.learners[i];
        if (!L.estimateLabel) return [{ title: `${Pn} learner state`, series: [], emptyText: `${Pn} plays a fixed strategy: nothing is learned.` }];
        const out = [actionChart(v, "est", i, `${Pn} ${L.estimateLabel.toLowerCase()}`)];
        if (L.hasWeights) out.push(actionChart(v, "w", i, `${Pn} normalized weights`, { yMin: 0, yMax: 1 }));
        return out;
      }
      case "regret": {
        note.textContent = "External regret: best fixed action in hindsight vs realized opponent play. Pseudo-regret: vs the best response to a stationary opponent (shown only when that exists).";
        const applicable = vs.filter((x) => x.info.benchmarks[i].applies);
        return [
          chartFromViews(vs, `ext${i}`, `${Pn} external regret`, { hlines: [{ y: 0 }] }),
          applicable.length
            ? chartFromViews(applicable, `pseudo${i}`, `${Pn} pseudo-regret`, { hlines: [{ y: 0 }] })
            : { title: `${Pn} pseudo-regret`, series: [], emptyText: vs[0].info.benchmarks[i].reason },
        ];
      }
      case "compare": {
        if (rvs.length < 2) return [{ title: "Deployment differences", series: [], emptyText: "Use “Compare 4 deployments”." }];
        const b = state.baseline;
        const label = (sharedMetrics().find((m) => m.key === state.metric) || {}).label || state.metric;
        const series = [];
        rvs.forEach((x, j) => {
          if (j === b) return;
          const s = differenceSeries(j, b, state.metric);
          if (s) series.push({ label: `${x.name} − ${rvs[b].name}`, color: x.color, ...s });
        });
        const mc = state.run.kind === "mc";
        note.textContent = mc
          ? "All deployments share random streams in each repetition, so differences are paired; bands are pointwise 95% CIs."
          : "One paired trajectory per deployment. Switch to Monte Carlo for confidence intervals.";
        return [
          chartFromViews(vs, state.metric, label),
          { title: `${label}: difference vs ${rvs[b].name}${mc ? " · paired 95% CI" : ""}`, series, hlines: [{ y: 0 }], xLabel: xLabel(rvs), vlines: switchLines(rvs) },
        ];
      }
      default:
        return [];
    }
  }

  function renderPlots() {
    if (state.view !== "run") return;
    const nSaved = savedViews().length;
    const has = !!state.run || nSaved > 0;
    $("empty-results").hidden = has;
    $("plots-card").hidden = !has;
    $("summary-card").hidden = !has;
    $("overlay-info").hidden = !nSaved;
    $("overlay-text").textContent = `+ ${nSaved} saved run${nSaved === 1 ? "" : "s"}`;
    if (!has) return;
    const specs = plotSpecs();
    const box = $("plots");
    while (box.children.length > specs.length) box.lastChild.remove();
    while (box.children.length < specs.length) box.append(el("canvas", { role: "img" }));
    specs.forEach((spec, k) => C.draw(box.children[k], spec));
  }

  // ------------------------------------------------------- live round ----
  function renderProgress() {
    const run = state.run;
    if (!run || run.kind !== "single") return;
    $("progress").value = run.match.t / run.match.horizon;
    $("progress-label").textContent = `Round ${run.match.t} of ${run.match.horizon}${run.match.done ? " · finished" : ""}`;
  }

  /** Read-only matrix of the game being played (the run's copy if there is a run). */
  function renderLiveMatrix() {
    const g = state.run ? state.run.exp.game : state.exp.game;
    const table = $("live-matrix");
    if (E.validateGame(g).length) { table.replaceChildren(); return; }
    const head = el("tr", {}, el("th"), ...g.cols.map((c, j) => el("th", { "data-col": String(j), text: c })));
    const rows = g.rows.map((r, i) => el("tr", {}, el("th", { "data-row": String(i), text: r }),
      ...g.cols.map((_, j) => el("td", { class: "cell", "data-cell": `${i}-${j}`, text: fmt(g.payoff[i][j]) }))));
    table.replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));
    renderRound();
  }

  function highlight(rec) {
    document.querySelectorAll("#live-matrix .current, #live-matrix .current-row, #live-matrix .current-col").forEach((n) => n.classList.remove("current", "current-row", "current-col"));
    if (!rec) return;
    const [a, b] = rec.actions;
    const q = (sel) => document.querySelector(`#live-matrix ${sel}`);
    q(`td[data-cell="${a}-${b}"]`)?.classList.add("current");
    q(`th[data-row="${a}"]`)?.classList.add("current-row");
    q(`th[data-col="${b}"]`)?.classList.add("current-col");
  }

  function renderRound() {
    const panel = $("round-panel");
    const run = state.run;
    const rec = run && run.kind === "single" ? run.last : null;
    highlight(rec);
    if (!rec) {
      $("round-title").textContent = "";
      panel.replaceChildren(el("p", { class: "hint", text: run && run.kind !== "single"
        ? "Round-by-round details are shown for single runs."
        : "Press Play or Step: the cell being played lights up here." }));
      return;
    }
    const info = run.match.info;
    $("round-title").textContent = `round ${rec.t} of ${run.match.horizon}`;
    const signed = (x) => `${x > 0 ? "+" : ""}${fmt(x, 4)}`;
    const cols = [0, 1].map((i) => {
      const L = info.learners[i];
      const a = rec.actions[i];
      const obs = rec.observations[i];
      const dl = el("dl", {}, el("dt", { text: "Total" }), el("dd", { text: fmt(rec.cumulative[i], 4) }));
      const fixed = L.kind === "deployment" || E.KINDS[L.kind].fixed;
      if (fixed || !obs) dl.append(el("dt", { text: "Learns from" }), el("dd", { text: "nothing (fixed strategy)" }));
      else {
        dl.append(el("dt", { text: "Learns from" }), el("dd", { text: `reward ${fmt(obs.reward, 4)}${L.binarize ? " (binarized)" : ""}` }));
        if (obs.counterfactual) dl.append(el("dt", { text: "Counterfactual" }), el("dd", { text: info.names[i].map((n, k) => `${n} ${fmt(obs.counterfactual[k], 3)}`).join(", ") }));
      }
      if (rec.estimates[i]) dl.append(el("dt", { text: "Estimates" }), el("dd", { text: info.names[i].map((n, k) => `${n} ${fmt(rec.estimates[i][k], 3)}`).join(", ") }));
      return el("div", { class: `pl p${i + 1}` },
        el("div", { class: "pl-head" }, el("b", { text: `Player ${i + 1}` }), el("span", { text: L.label })),
        el("div", { class: "pl-main" },
          el("span", { class: "action", text: info.names[i][a] }),
          el("span", { class: "sub", text: `prob ${fmt(rec.policies[i][a], 3)}` }),
          el("span", { class: "payoff", text: signed(rec.payoffs[i]) })),
        dl);
    });
    panel.replaceChildren(...cols);
  }

  // ------------------------------------------------------------ summary ----
  function cellText(f) {
    if (!f || !Number.isFinite(f.mean)) return "—";
    if (f.n >= 2 && Number.isFinite(f.lo)) return `${fmt(f.mean)} [${fmt(f.lo)}, ${fmt(f.hi)}]`;
    return fmt(f.mean, 6);
  }

  function exploitText(info, i) {
    const c = info.candidates[i];
    if (!c.length) return "n/a (adaptive)";
    return c.map((x) => (c.length > 1 ? `${fmt(x.exploitability)}${x.selected ? "*" : ""}` : fmt(x.exploitability))).join(" / ");
  }

  const learnerName = (info, i) => (info.learners[i].kind === "deployment" ? "preset deployment" : info.learners[i].label);

  function renderSummary() {
    if (state.view !== "run") return;
    const table = $("summary");
    const vs = views(), rvs = runViews();
    if (!vs.length) { table.replaceChildren(); $("summary-sub").textContent = ""; return; }
    const run = state.run;
    const nSaved = vs.length - rvs.length;
    const base = !run ? "final round"
      : run.kind === "mc" ? `final round · mean [95% CI] over ${run.result.reps} repetitions${run.result.cancelled ? " (cancelled early)" : ""}`
        : `final round · single trajectory (rep #${run.rep})`;
    $("summary-sub").textContent = base + (nSaved ? ` · plus ${nSaved} saved run${nSaved === 1 ? "" : "s"}` : "");
    const head = el("tr", {}, el("th", { text: "" }), ...vs.map((v) => el("th", {
      class: v.saved ? "saved-col" : null,
      title: v.saved ? savedDetails(v.saved) : v.arm === "configured" ? "" : E.ARMS[v.arm].label,
    }, v.saved ? el("span", { class: `swatch c${v.saved.colorIndex}` }) : null, v.name)));
    const rows = [];
    const section = (label) => rows.push(el("tr", { class: "section" }, el("td", { colspan: String(vs.length + 1), text: label })));
    const row = (label, fn) => rows.push(el("tr", {}, el("td", { text: label }), ...vs.map((v, a) => el("td", { text: fn(v, a) }))));
    const presetOf = (v) => E.isPresetGame(v.exp.game, v.exp.sim.epsilon);
    row("Rounds played", (v) => { const f = v.final("cum0"); return f ? String(f.t) : "0"; });
    for (const i of [0, 1]) {
      const labels = vs.map((v) => learnerName(v.info, i));
      const same = labels.every((l) => l === labels[0]);
      section(`Player ${i + 1}${same ? ` · ${labels[0]}` : ""}`);
      if (!same) row("Strategy", (v, a) => labels[a]);
      row("Cumulative payoff", (v) => cellText(v.final(`cum${i}`)));
      row("Average payoff", (v) => cellText(v.final(`avg${i}`)));
      row("External regret", (v) => cellText(v.final(`ext${i}`)));
      if (vs.some((v) => v.info.benchmarks[i].applies)) row("Pseudo-regret", (v) => (v.info.benchmarks[i].applies ? cellText(v.final(`pseudo${i}`)) : "n/a"));
      if (i === 0 && vs.some(presetOf)) {
        row("2ε × #B", (v) => {
          if (!presetOf(v)) return "n/a";
          const f = v.final("freq0_1"), eps = v.exp.sim.epsilon;
          return f && Number.isFinite(f.mean) ? cellText({ ...f, mean: f.mean * f.t * 2 * eps, lo: f.lo * f.t * 2 * eps, hi: f.hi * f.t * 2 * eps }) : "—";
        });
      }
      const actionNames = [...new Set(vs.flatMap((v) => v.info.names[i]))];
      actionNames.forEach((n) => row(`Frequency of ${n}`, (v) => {
        const a = v.info.names[i].indexOf(n);
        return a < 0 ? "—" : cellText(v.final(`freq${i}_${a}`));
      }));
      if (vs.some((v) => v.info.candidates[i].length)) row("Exploitability", (v) => exploitText(v.info, i));
    }
    if (rvs.length > 1) {
      section(`Difference vs ${rvs[state.baseline].name}${run.kind === "mc" ? " (paired 95% CI)" : ""}`);
      for (const [key, label] of [["cum0", "Δ P1 cumulative payoff"], ["pseudo0", "Δ P1 pseudo-regret"], ["ext0", "Δ P1 external regret"]]) {
        row(label, (v, a) => {
          if (a >= rvs.length) return "";
          if (a === state.baseline) return "baseline";
          const s = differenceSeries(a, state.baseline, key);
          if (!s) return "—";
          const k = s.ys.length - 1;
          return run.kind === "mc" ? cellText({ mean: s.ys[k], lo: s.lo[k], hi: s.hi[k], n: run.result.reps }) : fmt(s.ys[k], 6);
        });
      }
    }
    table.replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));
  }

  function renderResults() {
    renderTabs();
    renderProgress();
    renderRound();
    renderPlots();
    renderSummary();
    updateControls();
  }

  // --------------------------------------------------------- saved runs ----
  /** Browser storage (IndexedDB keeps typed arrays and has room for many runs). */
  const store = (() => {
    let dbp = null;
    const open = () => (dbp = dbp || new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open("normalform", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("runs", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction("runs", mode);
        const req = fn(t.objectStore("runs"));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    };
    return {
      all: () => tx("readonly", (s) => s.getAll()),
      put: (entry) => tx("readwrite", (s) => s.put(entry)),
      remove: (id) => tx("readwrite", (s) => s.delete(id)),
      clear: () => tx("readwrite", (s) => s.clear()),
    };
  })();

  function storageFailed(err) {
    state.storageNote = err && err.name === "QuotaExceededError"
      ? "Browser storage is full: new runs are kept only until this page is closed. Delete some saved runs to free space."
      : "This browser does not allow storage for this page, so saved runs are kept only until it is closed.";
    renderSaved();
  }

  const persist = (entry) => { store.put(entry).catch(storageFailed); };
  const savedColor = (e) => SAVED_COLORS[e.colorIndex % SAVED_COLORS.length];
  const savedLabel = (e) => `#${e.num} ${e.name}`;

  function defaultRunName(exp, arm) {
    const p2 = arm === "configured" ? playerLabel(1, exp, arm) : E.ARMS[arm].short;
    return `${playerLabel(0, exp, arm)} vs ${p2}`;
  }

  function savedDetails(e) {
    const g = e.exp.game;
    const game = E.isPresetGame(g, e.exp.sim.epsilon) ? `preset game, ε = ${e.exp.sim.epsilon}` : `${g.rows.length}×${g.cols.length} game`;
    const how = e.kind === "mc" ? `Monte Carlo, n = ${e.reps}${e.cancelled ? " (cancelled early)" : ""}` : `single run, repetition #${e.rep}`;
    return `${game} · T = ${e.exp.sim.horizon} · seed ${e.exp.sim.seed} · ${how}`;
  }

  /** Save every deployment of a finished run once; an identical earlier run is reused instead. */
  function saveRun(run) {
    if (run.savedIds) return;
    const parts = run.kind === "mc"
      ? run.result.arms.map((arm, a) => ({ arm, kind: "mc", reps: run.result.reps, cancelled: run.result.cancelled, snap: () => A.snapshotMonteCarlo(run.result, a) }))
      : (run.kind === "single" ? [{ arm: run.arm, traj: run.traj }] : run.arms.map((arm, a) => ({ arm, traj: run.trajs[a] })))
        .map(({ arm, traj }) => ({ arm, kind: "single", rep: run.rep, snap: () => A.snapshotTrajectory(traj) }));
    run.savedIds = parts.map((p) => {
      const key = [run.signature, p.kind, p.arm, p.kind === "mc" ? `n${p.reps}` : `r${p.rep}`].join("|");
      const existing = state.saved.find((e) => e.key === key);
      if (existing) return existing.id;
      const num = state.saved.reduce((m, e) => Math.max(m, e.num), 0) + 1;
      const entry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, key, num, colorIndex: (num - 1) % SAVED_COLORS.length,
        name: defaultRunName(run.exp, p.arm), created: Date.now(), visible: true,
        kind: p.kind, arm: p.arm, rep: p.rep ?? null, reps: p.reps ?? null, cancelled: !!p.cancelled,
        exp: E.cloneExperiment(run.exp), data: p.snap(),
      };
      state.saved.push(entry);
      persist(entry);
      return entry.id;
    });
    renderSaved();
  }

  function updateSaved(e, patch) {
    Object.assign(e, patch);
    persist(e);
    renderSaved();
  }

  function deleteSaved(e) {
    state.saved = state.saved.filter((x) => x !== e);
    store.remove(e.id).catch(storageFailed);
    renderSaved();
  }

  function clearSaved() {
    const n = state.saved.length;
    if (!n || !window.confirm(`Delete all ${n} saved run${n === 1 ? "" : "s"}? This cannot be undone.`)) return;
    state.saved = [];
    store.clear().catch(storageFailed);
    renderSaved();
  }

  function loadSavedSetup(e) {
    const exp = E.cloneExperiment(e.exp);
    exp.sim.deployment = e.arm;
    state.mode = e.kind === "mc" ? "mc" : "single";
    document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;
    document.body.className = `mode-${state.mode}`;
    loadExperiment(exp);
    if (e.kind === "single") { state.repIndex = e.rep; bindSimFields(); changed(); }
    setView("setup");
  }

  function loadSaved() {
    store.all().then((list) => {
      const ok = list.filter((e) => e && e.id && e.exp && e.data && e.data.ts && e.data.info && Number.isInteger(e.num));
      const known = new Set(ok.map((e) => e.id));
      state.saved = [...ok, ...state.saved.filter((e) => !known.has(e.id))].sort((a, b) => a.num - b.num);
      renderSaved();
      if (state.view === "run") renderResults();
    }).catch(storageFailed);
  }

  function renderSaved() {
    const list = state.saved;
    $("saved-count").textContent = list.length ? String(list.length) : "";
    if (state.view !== "saved") return;
    $("saved-notice").textContent = state.storageNote;
    $("saved-notice").hidden = !state.storageNote;
    $("saved-empty").hidden = list.length > 0;
    $("saved-card").hidden = list.length === 0;
    for (const id of ["saved-show-all", "saved-hide-all", "saved-clear"]) $(id).disabled = list.length === 0;
    const shown = list.filter((e) => e.visible).length;
    $("saved-sub").textContent = list.length ? `${list.length} saved · ${shown} shown in charts` : "";
    const head = el("tr", {}, ...[["In charts"], ["Run"], ["P1 avg payoff", "metric"], ["P1 external regret", "metric"], ["P1 pseudo-regret", "metric"], [""]]
      .map(([t, cls]) => el("th", { class: cls || null, text: t })));
    const rows = list.slice().reverse().map((e) => {
      const final = (key) => {
        const [value, ci] = cellText(e.data.final[key]).split(" [");
        return ci ? [value, el("div", { class: "sub", title: "95% confidence interval", text: `[${ci}` })] : value;
      };
      const id = `saved-vis-${e.id}`;
      const renamed = e.name !== defaultRunName(e.exp, e.arm);
      const when = new Date(e.created).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
      return el("tr", { class: e.visible ? null : "off" },
        el("td", { class: "vis" }, el("label", { for: id },
          el("input", { type: "checkbox", id, checked: e.visible, onchange: (ev) => updateSaved(e, { visible: ev.target.checked }) }),
          el("span", { class: `swatch c${e.colorIndex}` }), el("span", { class: "num", text: `#${e.num}` }))),
        el("td", { class: "run" },
          el("input", {
            type: "text", value: e.name, maxlength: "120", title: `${e.name} (click to rename)`, "aria-label": `Name of run #${e.num}`,
            onchange: (ev) => updateSaved(e, { name: ev.target.value.trim() || defaultRunName(e.exp, e.arm) }),
          }),
          renamed ? el("div", { class: "players" }, el("span", { class: "dot p1" }), ` ${playerLabel(0, e.exp, e.arm)} `,
            el("span", { class: "vs", text: "vs" }), " ", el("span", { class: "dot p2" }), ` ${playerLabel(1, e.exp, e.arm)}`) : null,
          el("div", { class: "sub", text: `${savedDetails(e)} · saved ${when}` })),
        el("td", { class: "metric" }, final("avg0")),
        el("td", { class: "metric" }, final("ext0")),
        el("td", { class: "metric" }, e.data.info.benchmarks[0].applies ? final("pseudo0") : "n/a"),
        el("td", { class: "actions" },
          el("button", { type: "button", class: "small ghost", title: "Copy this run's configuration into Set up", onclick: () => loadSavedSetup(e) }, "Load setup"),
          el("button", { type: "button", class: "icon", title: "Delete this saved run", "aria-label": `Delete run #${e.num}`, onclick: () => deleteSaved(e) }, "×")));
    });
    $("saved-table").replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));
  }

  // ------------------------------------------------------------ exports ----
  function exportCSV() {
    const run = state.run;
    if (!run) return;
    let csv;
    if (run.kind === "mc") csv = A.monteCarloCSV(run.result);
    else if (run.kind === "single") csv = A.trajectoryCSV([{ arm: run.arm, traj: run.traj }]);
    else csv = A.trajectoryCSV(run.arms.map((arm, a) => ({ arm, traj: run.trajs[a] })));
    download(`normalform-${run.kind}-results.csv`, csv, "text/csv");
  }

  function exportPNG() {
    const tab = TABS.find((t) => t[0] === state.tab);
    const url = C.compositePNG([...$("plots").children], `${state.run ? state.run.exp.name || "" : ""} — ${tab ? tab[1] : ""}`);
    if (url) download(`normalform-${state.tab}.png`, url);
  }

  function loadExperiment(raw) {
    const exp = E.normalizeExperiment(raw && raw.experiment ? raw.experiment : raw);
    reset();
    state.exp = exp;
    state.tab = "payoff";
    renderAll();
    const errs = currentErrors();
    if (errs.length) $("setup-errors").prepend(el("li", { text: "Loaded, but the configuration needs attention:" }));
  }

  // --------------------------------------------------------------- init ----
  function init() {
    const sel = $("preset-select");
    sel.replaceChildren(...P.list.map((p) => el("option", { value: p.id, text: p.experiment.name })));
    $("load-preset").onclick = () => loadExperiment(P.byId(sel.value));
    $("save-json").onclick = () => download(`${(state.exp.name || "experiment").replace(/[^\w-]+/g, "_").slice(0, 60)}.json`, E.serializeExperiment(state.exp), "application/json");
    $("load-json").onclick = () => $("file-input").click();
    $("file-input").onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 5e6) { $("setup-errors").replaceChildren(el("li", { text: "File too large for a configuration (> 5 MB)." })); return; }
      file.text().then((text) => {
        try { loadExperiment(JSON.parse(text)); } catch (err) {
          const msg = `Could not load ${file.name}: ${err.message}`;
          $("setup-errors").replaceChildren(el("li", { text: msg }));
          showErrors([msg]);
        }
      });
    };
    $("nav-setup").onclick = () => setView("setup");
    $("nav-run").onclick = () => setView("run");
    $("nav-saved").onclick = () => setView("saved");
    $("overlay-manage").onclick = () => setView("saved");
    $("saved-open-charts").onclick = () => setView("run");
    const showAll = (visible) => {
      state.saved.forEach((e) => { if (e.visible !== visible) { e.visible = visible; persist(e); } });
      renderSaved();
    };
    $("saved-show-all").onclick = () => showAll(true);
    $("saved-hide-all").onclick = () => showAll(false);
    $("saved-clear").onclick = clearSaved;
    $("go-run").onclick = () => setView("run");
    $("edit-setup").onclick = () => setView("setup");
    $("add-row").onclick = () => addAction(0);
    $("add-col").onclick = () => addAction(1);
    document.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.onchange = () => { state.mode = r.value; document.body.className = `mode-${state.mode}`; updateControls(); };
    });
    document.body.className = `mode-${state.mode}`;
    $("btn-play").onclick = play;
    $("btn-pause").onclick = pause;
    $("btn-step").onclick = step;
    $("btn-fast").onclick = fast;
    $("btn-run-mc").onclick = () => startMonteCarlo([deployment()]);
    $("btn-compare").onclick = startCompare;
    $("btn-cancel").onclick = cancel;
    $("btn-reset").onclick = reset;
    $("speed").oninput = updateControls;
    $("plot-player").onchange = (e) => { state.plotPlayer = Number(e.target.value); renderPlots(); };
    $("plot-arm").onchange = (e) => { state.plotArm = Number(e.target.value); renderPlots(); };
    $("plot-baseline").onchange = (e) => { state.baseline = Number(e.target.value); renderPlots(); renderSummary(); };
    $("plot-metric").onchange = (e) => { state.metric = e.target.value; renderPlots(); };
    $("export-csv").onclick = exportCSV;
    $("export-png").onclick = exportPNG;
    let resizeTimer = null;
    new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPlots, 80); }).observe($("plots"));
    renderAll();
    setView("setup");
    loadSaved();
  }

  init();
  window.NFApp = { state, play, step, fast, startCompare, startMonteCarlo, reset, loadExperiment, setView, clearSaved };
})();
