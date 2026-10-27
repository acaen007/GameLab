/*
 * Game switch (top bar) and the Kuhn / Leduc view: strategy portfolios, payoff matrix and
 * reward distribution. All user-provided text is rendered with textContent only.
 */
(function () {
  "use strict";
  const PK = window.NFPoker, C = window.NFCharts;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "gamelab.poker.v1";
  const MAX_STRATEGIES = 30;
  const COLORS = { p1: "#2563eb", p2: "#d9480f", tie: "#9ca3af" };
  const DEFAULTS = {
    kuhn: [["nash", "uniform", "maniac"], ["nash", "station", "tight"]],
    leduc: [["uniform", "tight", "maniac"], ["uniform", "station", "tight"]],
  };

  const state = { game: "normal", data: {}, open: [null, null], dist: null, tree: { open: {}, hideZero: false }, infer: null };

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

  const signed = (v, d = 3) => {
    const x = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v;
    return `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`;
  };
  const pct = (p) => `${(p * 100).toFixed(1)}%`;
  const probText = (v) => String(+v.toFixed(3));
  function parseProb(text) {
    const t = String(text).trim();
    const frac = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/.exec(t);
    const v = frac ? Number(frac[1]) / Number(frac[2]) : /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
    return v >= 0 && v <= 1 ? v : null;
  }

  // -------------------------------------------------------------- storage ----
  let counter = 0;
  const newId = () => `s${(counter += 1)}`;
  const withId = (s) => (s.alpha === undefined ? { id: newId(), name: s.name, probs: s.probs } : { id: newId(), name: s.name, probs: s.probs, alpha: s.alpha });

  function freshData(game) {
    return { portfolios: DEFAULTS[game].map((keys, i) => keys.map((k) => withId(PK.makeStrategy(game, k, i)))), selected: [0, 0] };
  }

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (err) { saved = null; }
    for (const game of Object.keys(PK.GAMES)) {
      const d = saved && typeof saved === "object" ? saved[game] : null;
      if (d && Array.isArray(d.portfolios) && d.portfolios.length === 2) {
        state.data[game] = {
          portfolios: d.portfolios.map((list, i) => (Array.isArray(list) ? list : []).slice(0, MAX_STRATEGIES).map((s) => withId(PK.normalizeStrategy(game, s, i)))),
          selected: [0, 1].map((i) => (Array.isArray(d.selected) && Number.isInteger(d.selected[i]) && d.selected[i] >= 0 ? d.selected[i] : 0)),
        };
      } else {
        state.data[game] = freshData(game);
      }
    }
  }

  function save() {
    const out = {};
    for (const [game, d] of Object.entries(state.data)) {
      out[game] = { portfolios: d.portfolios.map((list) => list.map(({ name, probs, alpha }) => ({ name, probs, alpha }))), selected: d.selected };
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(out)); } catch (err) { /* storage unavailable: keep in memory only */ }
  }

  // ---------------------------------------------------------- game switch ----
  function setGame(game) {
    if (!PK.GAMES[game]) game = "normal";
    state.game = game;
    document.querySelectorAll('input[name="game"]').forEach((r) => { r.checked = r.value === game; });
    const poker = game !== "normal";
    $("nf-nav").hidden = poker;
    $("view-poker").hidden = !poker;
    document.title = poker ? `${PK.GAMES[game].name} · Game Lab` : "Game Lab";
    if (poker) {
      for (const v of ["setup", "run", "saved"]) $(`view-${v}`).hidden = true;
      state.open = [null, null];
      render();
      window.scrollTo(0, 0);
    } else {
      window.NFApp.setView(window.NFApp.state.view);
    }
    if (location.hash.slice(1) !== (poker ? game : "")) {
      try { history.replaceState(null, "", location.pathname + location.search + (poker ? `#${game}` : "")); } catch (err) { /* ignore */ }
    }
  }

  // ----------------------------------------------------------- portfolios ----
  const data = () => state.data[state.game];

  function uniqueName(list, base) {
    if (!list.some((s) => s.name === base)) return base;
    let k = 2;
    while (list.some((s) => s.name === `${base} ${k}`)) k += 1;
    return `${base} ${k}`;
  }

  function clampSelection(d) {
    d.selected = d.selected.map((x, i) => Math.max(0, Math.min(x, d.portfolios[i].length - 1)));
  }

  function changed(i) {
    save();
    if (i !== undefined) renderPortfolio(i);
    renderResults();
  }

  function addStrategy(i, key) {
    const list = data().portfolios[i];
    if (list.length >= MAX_STRATEGIES) return;
    const s = withId(PK.makeStrategy(state.game, key, i));
    s.name = uniqueName(list, s.name);
    list.push(s);
    state.open[i] = s.id;
    changed(i);
  }

  function duplicateStrategy(i, k) {
    const list = data().portfolios[i];
    if (list.length >= MAX_STRATEGIES) return;
    const s = list[k];
    const copy = withId({ name: uniqueName(list, `${s.name} (copy)`), probs: JSON.parse(JSON.stringify(s.probs)), alpha: s.alpha });
    list.splice(k + 1, 0, copy);
    const d = data();
    if (d.selected[i] > k) d.selected[i] += 1;
    state.open[i] = copy.id;
    changed(i);
  }

  function removeStrategy(i, k) {
    const d = data(), list = d.portfolios[i];
    const [gone] = list.splice(k, 1);
    if (state.open[i] === gone.id) state.open[i] = null;
    if (d.selected[i] > k) d.selected[i] -= 1;
    clampSelection(d);
    changed(i);
  }

  function toggleEditor(i, id) {
    state.open[i] = state.open[i] === id ? null : id;
    renderPortfolio(i);
  }

  function addMenu(i) {
    const full = data().portfolios[i].length >= MAX_STRATEGIES;
    const menu = el("details", { class: "menu" });
    menu.append(
      el("summary", { class: `button small${full ? " disabled" : ""}`, title: full ? `At most ${MAX_STRATEGIES} strategies` : "Add a strategy from a template" }, "+ Add strategy"),
      el("div", { class: "menu-list", role: "menu" },
        el("div", { class: "menu-title", text: "Start from" }),
        ...PK.templatesFor(state.game).map((t) => el("button", {
          type: "button", role: "menuitem", disabled: full,
          onclick: () => { menu.open = false; addStrategy(i, t.key); },
        }, el("span", { class: "menu-label", text: t.label }), el("span", { class: "menu-note", text: t.note(state.game, i) })))));
    return menu;
  }

  function renderPortfolio(i) {
    const list = data().portfolios[i];
    const count = `${list.length} ${list.length === 1 ? "strategy" : "strategies"}`;
    const head = el("div", { class: "card-head" },
      el("div", {},
        el("h2", { class: "player-title" }, el("span", { class: "dot" }), `Player ${i + 1}`),
        el("span", { class: "sub", text: `${i === 0 ? "Acts first" : "Acts second"} · ${count}` })),
      addMenu(i));
    const body = list.length
      ? el("ol", { class: "strat-list" }, ...list.map((s, k) => strategyItem(i, s, k)))
      : el("div", { class: "strat-empty", text: "No strategies yet. Use “+ Add strategy” to start from a template." });
    $(`portfolio-${i}`).replaceChildren(head, body);
  }

  function strategyItem(i, s, k) {
    const open = state.open[i] === s.id;
    const nameButton = el("button", {
      type: "button", class: "strat-name", "aria-expanded": String(open), title: open ? "Close the editor" : "Edit this strategy",
      onclick: () => toggleEditor(i, s.id),
    }, s.name);
    const row = el("div", { class: "strat-row" },
      el("span", { class: `badge p${i + 1}`, text: String(k + 1) }),
      nameButton,
      el("span", { class: "strat-actions" },
        el("button", { type: "button", class: "small ghost", onclick: () => toggleEditor(i, s.id) }, open ? "Done" : "Edit"),
        el("button", { type: "button", class: "small ghost", title: "Duplicate", onclick: () => duplicateStrategy(i, k) }, "Duplicate"),
        el("button", { type: "button", class: "icon", title: "Remove", "aria-label": `Remove ${s.name}`, onclick: () => removeStrategy(i, k) }, "×")));
    return el("li", { class: `strat-item${open ? " open" : ""}` }, row, open ? editor(i, s, nameButton) : null);
  }

  // --------------------------------------------------------------- editor ----
  function editor(i, s, nameButton) {
    const game = state.game, g = PK.GAMES[game], help = PK.paramHelp(game, i);
    const nameInput = el("input", {
      type: "text", value: s.name, maxlength: "80", "aria-label": "Strategy name",
      oninput: (e) => { s.name = e.target.value.trim() || "Strategy"; nameButton.textContent = s.name; changed(); },
    });
    const fill = el("select", {
      "aria-label": "Replace all probabilities with a template",
      onchange: (e) => {
        if (!e.target.value) return;
        const t = PK.makeStrategy(game, e.target.value, i);
        s.probs = t.probs;
        if (t.alpha === undefined) delete s.alpha; else s.alpha = t.alpha;
        changed(i);
      },
    }, el("option", { value: "", text: "Choose a template…" }), ...PK.templatesFor(game).map((t) => el("option", { value: t.key, text: t.label })));

    const ctx = { syncs: [], edited: () => {} };
    const multi = g.rounds.length > 1;
    const table = el("table", { class: "param-table" },
      el("thead", {}, el("tr", {},
        el("th", { class: "corner", text: multi ? "Hand" : "Card" }),
        ...g.params.map((p) => el("th", { text: PK.PARAM_LABELS[p], title: help[p] })))),
      ...g.rounds.map((round, r) => el("tbody", {},
        multi ? el("tr", { class: "round-row" }, el("th", { colspan: String(g.params.length + 1), text: round.label })) : null,
        ...round.classes.map((c) => el("tr", {},
          el("th", { class: "cls", text: c.label }),
          ...g.params.map((p) => el("td", {}, probControl(s.probs[r][c.key], p, `${multi ? `${round.label}, ` : ""}${c.label}: ${PK.PARAM_LABELS[p]}`, ctx))))))));

    return el("div", { class: "strat-editor" },
      el("div", { class: "editor-top" },
        el("label", { class: "field grow" }, "Name", nameInput),
        el("label", { class: "field" }, "Reset to template", fill)),
      s.alpha === undefined ? null : alphaPanel(s, ctx, [nameButton, nameInput]),
      el("div", { class: "table-wrap" }, table),
      el("dl", { class: "param-help" }, ...g.params.flatMap((p) => [el("dt", { text: PK.PARAM_LABELS[p] }), el("dd", { text: help[p] })])));
  }

  // Kuhn Player 1 equilibrium family: one slider for α drives the K, Q and J rows of the table.
  function alphaPanel(s, ctx, nameEls) {
    const AUTO_NAME = /^(Nash \(α = [^)]*\)|Nash equilibrium)/;
    const range = el("input", { type: "range", min: "0", max: String(PK.ALPHA_MAX), step: "any", value: String(s.alpha), "aria-label": "Bluff frequency α" });
    const text = el("input", { type: "text", inputmode: "decimal", class: "prob-text", value: PK.alphaText(s.alpha), "aria-label": "Bluff frequency α", title: "A value in [0, 1/3]; fractions like 1/6 work" });
    const note = el("p", { class: "alpha-note" });
    const status = () => {
      const ok = PK.nashAlpha(s.probs) !== null;
      note.classList.toggle("warn", !ok);
      note.textContent = ok
        ? "Bets J with α, bets K with 3α and, after checking, calls with Q with α + 1/3. Every α from 0 to 1/3 is an equilibrium worth −1/18 to Player 1."
        : "The table was edited by hand, so this is no longer an equilibrium. Moving α resets the K, Q and J rows.";
    };
    const show = () => { range.value = String(s.alpha); text.value = PK.alphaText(s.alpha); text.classList.remove("invalid"); };
    const setAlpha = (a) => {
      s.alpha = a;
      const n = PK.kuhnNash(0, a)[0];
      for (const c of Object.keys(n)) Object.assign(s.probs[0][c], n[c]);
      ctx.syncs.forEach((f) => f());
      if (AUTO_NAME.test(s.name)) {
        s.name = s.name.replace(AUTO_NAME, PK.nashName(a));
        nameEls[0].textContent = s.name;
        nameEls[1].value = s.name;
      }
      status();
      changed();
    };
    range.addEventListener("input", () => {
      const v = Number(range.value);
      setAlpha(v > PK.ALPHA_MAX - 0.005 ? PK.ALPHA_MAX : Math.round(v * 100) / 100);
      text.value = PK.alphaText(s.alpha);
      text.classList.remove("invalid");
    });
    text.addEventListener("input", () => {
      const v = parseProb(text.value);
      const ok = v !== null && v <= PK.ALPHA_MAX + 1e-9;
      text.classList.toggle("invalid", !ok);
      if (!ok) return;
      setAlpha(Math.min(PK.ALPHA_MAX, v));
      range.value = String(s.alpha);
    });
    text.addEventListener("change", show);
    ctx.edited = () => {
      const a = PK.nashAlpha(s.probs);
      if (a !== null) { s.alpha = a; show(); }
      status();
    };
    status();
    return el("div", { class: "alpha-panel" },
      el("div", { class: "alpha-row" },
        el("span", { class: "alpha-label", text: "Bluff frequency α" }),
        el("div", { class: "alpha-slider" }, range, el("div", { class: "alpha-scale" }, el("span", { text: "0" }), el("span", { text: "1/6" }), el("span", { text: "1/3" }))),
        text),
      note);
  }

  function probControl(obj, key, label, ctx) {
    const range = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(obj[key]), "aria-label": label });
    const text = el("input", { type: "text", inputmode: "decimal", class: "prob-text", value: probText(obj[key]), "aria-label": label, title: "A probability in [0, 1]; fractions like 1/3 work" });
    ctx.syncs.push(() => { range.value = String(obj[key]); text.value = probText(obj[key]); text.classList.remove("invalid"); });
    range.addEventListener("input", () => {
      obj[key] = Number(range.value);
      text.value = probText(obj[key]);
      text.classList.remove("invalid");
      ctx.edited();
      changed();
    });
    text.addEventListener("input", () => {
      const v = parseProb(text.value);
      text.classList.toggle("invalid", v === null);
      if (v === null) return;
      obj[key] = v;
      range.value = String(v);
      ctx.edited();
      changed();
    });
    text.addEventListener("change", () => { text.value = probText(obj[key]); text.classList.remove("invalid"); });
    return el("div", { class: "prob" }, range, text);
  }

  // -------------------------------------------------------------- results ----
  function render() {
    const g = PK.GAMES[state.game];
    $("poker-title").textContent = g.name;
    $("poker-rules").textContent = g.rules;
    renderPortfolio(0);
    renderPortfolio(1);
    renderResults();
  }

  function renderResults() {
    const d = data(), [A, B] = d.portfolios;
    if (!A.length || !B.length) {
      $("poker-matrix").replaceChildren();
      $("poker-matrix-hint").textContent = "Add at least one strategy to each portfolio.";
      $("poker-dist").replaceChildren(el("p", { class: "hint first", text: "Add at least one strategy to each portfolio." }));
      $("poker-chart").hidden = true;
      $("poker-tree-card").hidden = true;
      $("poker-infer-card").hidden = true;
      state.dist = null;
      return;
    }
    clampSelection(d);
    renderMatrix(d);
    renderDistribution(d);
    syncInference(d);
    $("poker-infer-card").hidden = false;
    renderInference(d);
    $("poker-tree-card").hidden = false;
    renderTree(d);
  }

  function renderMatrix(d) {
    const game = state.game, [A, B] = d.portfolios;
    const M = PK.payoffMatrix(game, d.portfolios);
    const maxAbs = Math.max(1e-9, ...M.flat().map(Math.abs));
    const [si, sj] = d.selected;
    const select = (i, j) => {
      d.selected = [i, j];
      save();
      renderResults();
      const b = document.querySelector(`#poker-matrix [data-cell="${i}-${j}"]`);
      if (b) b.focus();
    };
    const head = el("tr", {},
      el("th", { class: "corner" }, el("span", { class: "p1", text: "P1 ↓" }), el("span", { class: "p2", text: "P2 →" })),
      ...B.map((s, j) => el("th", { class: `col-head${j === sj ? " sel" : ""}`, title: s.name },
        el("span", { class: "badge p2", text: String(j + 1) }), el("span", { class: "head-name", text: s.name }))));
    const rows = A.map((s, i) => el("tr", {},
      el("th", { class: `row-head${i === si ? " sel" : ""}`, title: s.name },
        el("span", { class: "badge p1", text: String(i + 1) }), el("span", { class: "head-name", text: s.name })),
      ...M[i].map((v, j) => {
        const level = Math.max(1, Math.min(5, Math.ceil((Math.abs(v) / maxAbs) * 5)));
        const tone = Math.abs(v) < 5e-4 ? "" : ` ${v > 0 ? "pos" : "neg"}${level}`;
        const on = i === si && j === sj;
        return el("td", {}, el("button", {
          type: "button", class: `pcell${tone}${on ? " sel" : ""}`, "aria-pressed": String(on), "data-cell": `${i}-${j}`,
          title: `${A[i].name} vs ${B[j].name}: ${signed(v, 4)} per hand for Player 1`,
          onclick: () => select(i, j),
        }, signed(v)));
      })));
    $("poker-matrix").replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));
    $("poker-matrix-hint").textContent = `Exact expectation over all ${PK.deals(game).length} deals and every action the strategies can take. Click a cell to see its reward distribution.`;
  }

  function renderDistribution(d) {
    const game = state.game, [A, B] = d.portfolios, [i, j] = d.selected;
    const r = PK.evaluate(game, [A[i], B[j]]);
    const tone = (v) => (v > 5e-4 ? "p1" : v < -5e-4 ? "p2" : "");
    const stat = (k, v, cls, title) => el("div", { class: `stat${cls ? ` ${cls}` : ""}`, title }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }));
    $("poker-dist").replaceChildren(
      el("div", { class: "dist-pair" },
        el("span", { class: "badge p1", text: String(i + 1) }), el("span", { class: "pair-name", text: A[i].name, title: A[i].name }),
        el("span", { class: "vs", text: "vs" }),
        el("span", { class: "badge p2", text: String(j + 1) }), el("span", { class: "pair-name", text: B[j].name, title: B[j].name })),
      el("div", { class: "stats" },
        stat("Expected payoff", signed(r.mean), tone(r.mean), "Player 1's mean payoff per hand"),
        stat("Std. deviation", r.sd.toFixed(3), "", "Standard deviation of Player 1's payoff for one hand"),
        stat("Player 1 wins", pct(r.win), "p1", "Probability that Player 1 wins chips"),
        game === "leduc" ? stat("Split pot", pct(r.tie), "", "Probability of a tie at showdown") : null,
        stat("Player 2 wins", pct(r.lose), "p2", "Probability that Player 2 wins chips")),
      el("p", { class: "ends" },
        "Hands end at ", el("b", { text: `showdown ${pct(r.showdown)}` }),
        " · Player 1 folds ", el("b", { text: pct(r.folds[0]) }),
        " · Player 2 folds ", el("b", { text: pct(r.folds[1]) })));
    $("poker-chart").hidden = false;
    state.dist = r;
    drawChart();
  }

  function drawChart() {
    const r = state.dist;
    if (!r || $("view-poker").hidden) return;
    const label = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
    C.bars($("poker-chart"), {
      bars: r.outcomes.map((o) => ({ label: label(o.value), value: o.prob, color: o.value > 0 ? COLORS.p1 : o.value < 0 ? COLORS.p2 : COLORS.tie })),
      xLabel: "Player 1's payoff for one hand (chips)",
      yLabel: "Probability",
      ariaLabel: `Distribution of Player 1's payoff: ${r.outcomes.filter((o) => o.prob > 0).map((o) => `${label(o.value)} with ${pct(o.prob)}`).join(", ")}`,
    });
  }

  // ------------------------------------------------------------ game tree ----
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TREE = { row: 26, col: 128, r: 10, pad: 16, tail: 100 };
  const TREE_HINT = "Hover or focus a node to trace its path. Click a node to expand or collapse it.";

  function svg(tag, attrs = {}, ...children) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
    for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  const chanceText = (p) => {
    for (let q = 1; q <= 30; q++) { const k = Math.round(p * q); if (Math.abs(p * q - k) < 1e-9) return k === q ? "1" : `${k}/${q}`; }
    return probText(p);
  };
  const reachText = (p) => (p <= 0 ? "0%" : p >= 0.01 ? `${(p * 100).toFixed(1)}%` : `${+(p * 100).toPrecision(2)}%`);
  const chips = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
  const who = (p) => `P${p + 1}`;

  /** Opens a node and every decision below it, stopping at the next chance node. */
  function openFrom(node, open) {
    open.add(node.id);
    for (const c of node.children) if (c.kind === "decision") openFrom(c, open);
    return open;
  }

  function treeLayout(root, open, hideZero) {
    const items = [];
    let rows = 0, depth = 0;
    const place = (n, level, parent) => {
      const item = { n, level, parent, open: n.kind !== "terminal" && open.has(n.id) };
      items.push(item);
      depth = Math.max(depth, level);
      const kids = item.open ? n.children.filter((c) => !hideZero || c.reach > 0) : [];
      if (kids.length) {
        const placed = kids.map((c) => place(c, level + 1, item));
        item.y = (placed[0].y + placed[placed.length - 1].y) / 2;
      } else {
        item.y = rows;
        rows += 1;
      }
      return item;
    };
    place(root, 0, null);
    return { items, rows, depth };
  }

  function renderTree(d) {
    const game = state.game, [A, B] = d.portfolios, [si, sj] = d.selected;
    const root = PK.gameTree(game, [A[si], B[sj]]);
    const opened = state.tree.open;
    if (!opened[game]) opened[game] = game === "kuhn" ? openFrom(root, new Set()) : new Set([root.id]);
    const open = opened[game];
    const rerender = (focusId) => {
      renderTree(data());
      if (focusId === undefined) return;
      const target = $("poker-tree").querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      if (target) target.focus();
    };

    const hide = el("input", { type: "checkbox", checked: state.tree.hideZero, onchange: (e) => { state.tree.hideZero = e.target.checked; rerender(); } });
    $("poker-tree-bar").replaceChildren(
      el("div", { class: "dist-pair" },
        el("span", { class: "badge p1", text: String(si + 1) }), el("span", { class: "pair-name", text: A[si].name, title: A[si].name }),
        el("span", { class: "vs", text: "vs" }),
        el("span", { class: "badge p2", text: String(sj + 1) }), el("span", { class: "pair-name", text: B[sj].name, title: B[sj].name })),
      el("div", { class: "tree-tools" },
        el("label", { class: "mini" }, hide, "Hide unreachable branches"),
        el("button", { type: "button", class: "small", title: game === "kuhn" ? "Show the whole tree" : "Show the first betting round of every deal", onclick: () => { opened[game] = openFrom(root, new Set()); rerender(); } },
          game === "kuhn" ? "Expand all" : "Expand round 1"),
        el("button", { type: "button", class: "small", onclick: () => { opened[game] = new Set([root.id]); rerender(); } }, "Collapse all")));

    const pathBox = $("poker-tree-path");
    pathBox.replaceChildren(TREE_HINT);
    pathBox.classList.remove("active");

    const { items, rows, depth } = treeLayout(root, open, state.tree.hideZero);
    const T = TREE, top = Math.max(1e-12, ...root.children.map((c) => c.reach));
    const X = (it) => T.pad + T.r + it.level * T.col;
    const Y = (it) => T.pad + it.y * T.row + T.row / 2;
    const width = T.pad * 2 + T.r + depth * T.col + T.tail, height = T.pad * 2 + rows * T.row;
    const links = [], nodes = [], plays = [], linkEls = new Map(), nodeEls = new Map(), infosets = new Map();
    const played = state.infer && state.infer.last ? new Set(state.infer.last.path.map((n) => n.id)) : null;
    const infoKey = (n) => (n.kind === "decision" ? `${n.player}:${n.card}:${n.id.slice(2)}` : null);

    for (const it of items) {
      const n = it.n, x = X(it), y = Y(it), zero = !(n.reach > 0);
      if (it.parent) {
        const px = X(it.parent), py = Y(it.parent), bx = px + T.r + 12, dy = y - py, s = Math.sign(dy), rr = Math.min(6, Math.abs(dy) / 2);
        const shape = Math.abs(dy) < 0.5 ? `M${px} ${py}H${x}` : `M${px} ${py}H${bx - rr}Q${bx} ${py} ${bx} ${py + s * rr}V${y - s * rr}Q${bx} ${y} ${bx + rr} ${y}H${x}`;
        const e = n.edge, side = e.type === "action" ? `p${e.player + 1}` : "chance";
        const name = e.type === "deal"
          ? [svg("tspan", { class: "tl-c1" }, e.cards[0]), svg("tspan", { class: "tl-sep" }, " · "), svg("tspan", { class: "tl-c2" }, e.cards[1])]
          : [svg("tspan", {}, e.type === "board" ? `Board ${e.card}` : e.action)];
        const link = svg("g", { class: `tlink ${side}${zero ? " zero" : ""}` },
          svg("path", { d: shape, "stroke-width": zero ? 1.25 : (1.5 + 5.5 * Math.min(1, n.reach / top)).toFixed(2) }),
          svg("text", { x: x - T.r - 6, y: y - 6, class: "tlabel", "text-anchor": "end" }, name,
            svg("tspan", { class: "tl-p", dx: 5 }, e.type === "action" ? probText(n.p) : chanceText(n.p))));
        links.push([zero ? 0 : n.reach, link]);
        linkEls.set(n.id, link);
        if (played && played.has(n.id)) plays.push(svg("path", { d: shape, class: "tplay" }));
      }

      const collapsed = n.kind !== "terminal" && !it.open;
      const kind = n.kind === "terminal" ? "term" : n.kind === "chance" ? "chance" : `p${n.player + 1}`;
      const mark = `${zero ? " zero" : ""}${collapsed ? " collapsed" : ""}${played && played.has(n.id) ? " played" : ""}`;
      const g = svg("g", { class: `tnode ${kind}${mark}`, transform: `translate(${x} ${y})`, "data-id": n.id });
      if (n.kind === "terminal") {
        const tone = n.payoff > 0 ? "pos" : n.payoff < 0 ? "neg" : "tie";
        g.append(
          svg("rect", { x: -T.r, y: -9, width: 34, height: 18, rx: 9, class: `tpill ${tone}` }),
          svg("text", { x: 7, y: 0, class: `tpay ${tone}`, "text-anchor": "middle", "dominant-baseline": "central" }, chips(n.payoff)),
          svg("text", { x: 32, y: 0, class: "treach", "dominant-baseline": "central" }, reachText(n.reach)));
      } else {
        if (collapsed) g.append(svg("circle", { r: T.r + 3.5, class: "tring" }));
        g.append(
          svg("circle", { r: T.r, class: "tdot" }),
          svg("text", { class: "tcard", "text-anchor": "middle", "dominant-baseline": "central" }, n.kind === "chance" ? "C" : n.card));
        if (collapsed) g.append(svg("text", { x: T.r + 9, y: 0, class: "treach", "dominant-baseline": "central" }, reachText(n.reach)));
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.setAttribute("aria-expanded", String(it.open));
        const toggle = () => {
          if (open.has(n.id)) open.delete(n.id); else openFrom(n, open);
          rerender(n.id);
        };
        g.addEventListener("click", toggle);
        g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      }
      const tip = nodeTip(n);
      g.setAttribute("aria-label", tip);
      g.append(svg("title", {}, tip));
      g.addEventListener("mouseenter", () => trace(it));
      g.addEventListener("focus", () => trace(it));
      nodes.push(g);
      nodeEls.set(n.id, g);
      const key = infoKey(n);
      if (key) { if (!infosets.has(key)) infosets.set(key, []); infosets.get(key).push(g); }
    }

    const svgEl = $("poker-tree");
    const untrace = () => {
      svgEl.classList.remove("tracing");
      svgEl.querySelectorAll(".hl, .iset").forEach((e) => e.classList.remove("hl", "iset"));
    };
    function trace(it) {
      untrace();
      svgEl.classList.add("tracing");
      const chain = [];
      for (let a = it; a; a = a.parent) {
        chain.unshift(a.n);
        nodeEls.get(a.n.id).classList.add("hl");
        if (linkEls.has(a.n.id)) linkEls.get(a.n.id).classList.add("hl");
      }
      const mates = infosets.get(infoKey(it.n)) || [];
      if (mates.length > 1) mates.forEach((m) => m.classList.add("iset"));
      showPath(chain, mates.length);
    }
    svgEl.onmouseleave = () => { untrace(); pathBox.replaceChildren(TREE_HINT); pathBox.classList.remove("active"); };

    function showPath(chain, mates) {
      const parts = [];
      const step = (cls, ...kids) => { if (parts.length) parts.push(el("span", { class: "arrow", text: "→" })); parts.push(el("span", { class: `step ${cls}` }, ...kids)); };
      for (const n of chain.slice(1)) {
        const e = n.edge;
        if (e.type === "deal") step("chance", "Deal ", el("span", { class: "c1", text: e.cards[0] }), " · ", el("span", { class: "c2", text: e.cards[1] }), " ", el("b", { text: chanceText(n.p) }));
        else if (e.type === "board") step("chance", `Board ${e.card} `, el("b", { text: chanceText(n.p) }));
        else step(`p${e.player + 1}`, el("span", { class: "who", text: who(e.player) }), ` ${e.action.toLowerCase()} `, el("b", { text: probText(n.p) }));
      }
      const last = chain[chain.length - 1];
      if (last.kind === "terminal") {
        const res = last.payoff > 0 ? `Player 1 wins ${last.payoff}` : last.payoff < 0 ? `Player 2 wins ${-last.payoff}` : "Split pot";
        step("end", `${last.end === "fold" ? `${who(last.folder)} folded` : "Showdown"}: ${res}`);
      } else if (last.kind === "decision" && mates > 1) {
        step("end", `${who(last.player)} to act; ${mates} outlined nodes share this information set`);
      }
      if (!chain.slice(1).length) step("chance", "Chance deals the private cards");
      parts.push(el("span", { class: "reach" }, "Reached in ", el("b", { text: reachText(last.reach) }), " of hands"));
      pathBox.replaceChildren(...parts);
      pathBox.classList.add("active");
    }

    links.sort((a, b) => a[0] - b[0]);
    svgEl.setAttribute("width", width);
    svgEl.setAttribute("height", height);
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svgEl.classList.remove("tracing");
    svgEl.replaceChildren(svg("g", { class: "tplays" }, plays), svg("g", {}, links.map((l) => l[1])), svg("g", {}, nodes));
  }

  function nodeTip(n) {
    const reach = `reached in ${reachText(n.reach)} of hands`;
    if (n.kind === "terminal") {
      return `${n.end === "fold" ? `Player ${n.folder + 1} folds` : "Showdown"}: Player 1 ${chips(n.payoff)}, ${reach}`;
    }
    if (n.kind === "chance") return `${n.edge ? "Chance deals the board card" : "Chance deals the private cards"}, ${reach}`;
    return `Player ${n.player + 1} to act holding ${n.card}${n.board ? ` (board ${n.board})` : ""}, ${reach}`;
  }

  // --------------------------------------------------- opponent inference ----
  // Player 1 keeps playing its selected strategy against the selected Player 2 strategy, which it does not know,
  // and after every hand applies Bayes' rule to a belief over Player 2's whole portfolio.
  const PALETTE = C.PALETTE;
  const likeText = (v) => (v <= 0 ? "0" : v >= 0.001 ? probText(v) : v.toExponential(1));

  function syncInference(d) {
    const [A, B] = d.portfolios, [si, sj] = d.selected;
    const sig = JSON.stringify([state.game, si, sj, A[si].probs, B.map((s) => s.probs)]);
    if (state.infer && state.infer.sig === sig) return;
    const prior = B.map(() => 1 / B.length);
    state.infer = { sig, tree: null, models: null, belief: prior, history: [prior], hands: 0, showdowns: 0, net: 0, last: null };
  }

  function playHands(count) {
    const d = data(), inf = state.infer, game = state.game, [A, B] = d.portfolios, [si, sj] = d.selected;
    if (!inf.models) {
      inf.tree = PK.gameTree(game, [A[si], B[sj]]);
      inf.models = B.map((s) => PK.observationModel(game, [A[si], s]));
    }
    for (let t = 0; t < count; t++) {
      const path = PK.sampleHand(inf.tree, Math.random), leaf = path[path.length - 1];
      const step = PK.updateBelief(inf.belief, inf.models, PK.observationKey(leaf));
      inf.last = { path, leaf, prior: inf.belief, likelihoods: step.likelihoods };
      inf.belief = step.posterior;
      inf.history.push(step.posterior);
      inf.hands += 1;
      inf.net += leaf.payoff;
      if (leaf.end === "showdown") inf.showdowns += 1;
    }
    const open = state.tree.open[game];
    if (open) for (const n of inf.last.path) if (n.kind !== "terminal") open.add(n.id);
    renderInference(d);
    renderTree(d);
  }

  function resetInference() {
    const d = data();
    state.infer = null;
    syncInference(d);
    renderInference(d);
    renderTree(d);
  }

  function renderInference(d) {
    const [A, B] = d.portfolios, [si, sj] = d.selected, inf = state.infer, last = inf.last;
    $("poker-infer-pair").replaceChildren(
      el("span", { class: "badge p1", text: String(si + 1) }), el("span", { class: "pair-name", text: A[si].name, title: A[si].name }),
      el("span", { class: "vs", text: "vs" }),
      el("span", { class: "badge p2", text: String(sj + 1) }), el("span", { class: "pair-name", text: B[sj].name, title: B[sj].name }),
      el("span", { class: "pair-note", text: "hidden from Player 1" }));

    const hand = $("poker-infer-hand");
    if (!last) {
      hand.classList.remove("active");
      hand.replaceChildren("No hands played yet. Belief starts uniform over Player 2's portfolio.");
      $("poker-infer-note").textContent = "Each hand is dealt and played at random by the selected pair. Player 1 sees its own card, every action, the board and, only at showdown, Player 2's card.";
    } else {
      hand.classList.add("active");
      hand.replaceChildren(...handSteps(inf.hands, last.path));
      const shown = last.leaf.end === "showdown", card = last.path[1].edge.cards[1];
      $("poker-infer-note").textContent = shown
        ? `Showdown: Player 2's ${card} is revealed, so each model's likelihood is the probability it gives to Player 2's actions holding ${card}.`
        : "Player 2's card is not revealed after a fold, so each model's likelihood averages over the cards Player 2 could hold.";
    }

    const head = el("tr", {},
      el("th", { text: "Player 2 model" }),
      el("th", { class: "num", text: "Likelihood", title: "Probability the model gives to Player 2's actions in the last hand" }),
      el("th", { text: "Belief" }));
    const rows = B.map((s, j) => {
      const now = inf.belief[j], before = last ? last.prior[j] : now, color = PALETTE[j % PALETTE.length];
      const bar = svg("svg", { class: "pbar", viewBox: "0 0 100 10", preserveAspectRatio: "none", "aria-hidden": "true" },
        svg("rect", { x: 0, y: 0, width: 100, height: 10, class: "pbar-bg" }),
        svg("rect", { x: 0, y: 0, width: (now * 100).toFixed(3), height: 10, fill: color }),
        last && Math.abs(before - now) >= 5e-4 ? svg("line", { x1: before * 100, x2: before * 100, y1: 0, y2: 10, class: "pbar-prev", "vector-effect": "non-scaling-stroke" }) : null);
      return el("tr", { class: now <= 0 ? "out" : null },
        el("td", {}, el("div", { class: "model" },
          svg("svg", { class: "swatch", viewBox: "0 0 10 10", "aria-hidden": "true" }, svg("circle", { cx: 5, cy: 5, r: 5, fill: color })),
          el("span", { class: "badge p2", text: String(j + 1) }),
          el("span", { class: "model-name", text: s.name, title: s.name }),
          j === sj ? el("span", { class: "true-tag", text: "true", title: "The strategy Player 2 is actually playing" }) : null)),
        el("td", { class: "num", text: last ? likeText(last.likelihoods[j]) : "–" }),
        el("td", { class: "belief-cell", title: last ? `${pct(before)} before the last hand` : "Prior" },
          el("div", { class: "pbar-row" }, bar, el("span", { class: "pbar-val", text: pct(now) }))));
    });
    $("poker-belief").replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));

    const stats = $("poker-infer-stats");
    if (!inf.hands) stats.replaceChildren();
    else {
      stats.replaceChildren(
        el("b", { text: `${inf.hands} hand${inf.hands === 1 ? "" : "s"}` }),
        " · showdowns ", el("b", { text: `${inf.showdowns} (${pct(inf.showdowns / inf.hands)})` }),
        " · Player 1 net ", el("b", { text: `${chips(inf.net)} chips` }),
        `, ${signed(inf.net / inf.hands)} per hand (expected ${signed(state.dist ? state.dist.mean : 0)})`);
    }
    drawInferChart();
  }

  /** The last hand as Player 1 saw it: Player 2's card is shown only at showdown. */
  function handSteps(index, path) {
    const parts = [el("span", { class: "step end", text: `Hand ${index}:` })];
    const leaf = path[path.length - 1], shown = leaf.end === "showdown";
    const step = (cls, ...kids) => { if (parts.length > 1) parts.push(el("span", { class: "arrow", text: "→" })); parts.push(el("span", { class: `step ${cls}` }, ...kids)); };
    for (const n of path.slice(1)) {
      const e = n.edge;
      if (e.type === "deal") {
        step("chance", "Deal ", el("span", { class: "c1", text: e.cards[0] }), " · ",
          shown ? el("span", { class: "c2", text: e.cards[1] }) : el("span", { class: "c2 hidden-card", text: "?", title: `Player 2 held ${e.cards[1]} (not revealed)` }));
      } else if (e.type === "board") step("chance", `Board ${e.card}`);
      else step(`p${e.player + 1}`, el("span", { class: "who", text: who(e.player) }), ` ${e.action.toLowerCase()}`);
    }
    const res = leaf.payoff > 0 ? `Player 1 wins ${leaf.payoff}` : leaf.payoff < 0 ? `Player 2 wins ${-leaf.payoff}` : "Split pot";
    step("end", `${shown ? "Showdown" : `${who(leaf.folder)} folded`}: ${res}`);
    return parts;
  }

  function drawInferChart() {
    const inf = state.infer, canvas = $("poker-infer-chart");
    if (!inf || $("view-poker").hidden || $("poker-infer-card").hidden) return;
    const [, B] = data().portfolios, sj = data().selected[1];
    const xs = inf.history.map((_, t) => t);
    C.draw(canvas, {
      title: "Belief over Player 2's portfolio",
      xLabel: "Hands played",
      yLabel: "Posterior probability",
      series: B.map((s, j) => ({ label: j === sj ? `${s.name} (true)` : s.name, color: PALETTE[j % PALETTE.length], width: j === sj ? 3 : 2, xs, ys: inf.history.map((b) => b[j]) })),
      yMin: 0, yMax: 1, xMin: 0, xMax: Math.max(10, inf.hands),
    });
  }

  // ----------------------------------------------------------------- init ----
  function init() {
    load();
    document.querySelectorAll('input[name="game"]').forEach((r) => r.addEventListener("change", () => setGame(r.value)));
    document.addEventListener("click", (e) => {
      document.querySelectorAll("details.menu[open]").forEach((m) => { if (!m.contains(e.target)) m.open = false; });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") document.querySelectorAll("details.menu[open]").forEach((m) => { m.open = false; });
    });
    window.addEventListener("hashchange", () => setGame(location.hash.slice(1)));
    let timer = 0;
    new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(drawChart, 60); }).observe($("poker-chart"));
    let inferTimer = 0;
    new ResizeObserver(() => { clearTimeout(inferTimer); inferTimer = setTimeout(drawInferChart, 60); }).observe($("poker-infer-chart"));
    document.querySelectorAll("#poker-infer-card [data-hands]").forEach((b) => b.addEventListener("click", () => playHands(Number(b.dataset.hands))));
    $("poker-infer-reset").addEventListener("click", resetInference);
    const tree = $("poker-tree");
    tree.addEventListener("focusout", (e) => { if (!tree.contains(e.relatedTarget) && tree.onmouseleave) tree.onmouseleave(); });
    const initial = location.hash.slice(1);
    if (PK.GAMES[initial]) setGame(initial);
  }

  init();
  window.NFPokerApp = { state, setGame };
})();
