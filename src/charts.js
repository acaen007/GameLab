/*
 * Minimal canvas line charts: multiple series, 95% bands, legends, reference
 * lines, NaN gaps, min/max decimation and HiDPI. Browser only: window.NFCharts.
 */
(function (root) {
  "use strict";

  const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563", "#65a30d", "#9333ea"];
  const FONT = "12px system-ui, -apple-system, Segoe UI, sans-serif";
  const SMALL = "11px system-ui, -apple-system, Segoe UI, sans-serif";

  function niceTicks(lo, hi, count = 5) {
    if (!(hi > lo)) { const d = Math.abs(lo) || 1; lo -= d / 2; hi += d / 2; }
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const start = Math.ceil(lo / step - 1e-9) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return ticks;
  }

  function fmtTick(v) {
    const a = Math.abs(v);
    if (a >= 1e5 || (a > 0 && a < 1e-3)) return v.toExponential(1);
    return String(+v.toPrecision(4));
  }

  /** Reduce to at most ~2 points per pixel column, keeping min and max of each bucket. */
  function decimate(xs, ys, x0, x1, pixels) {
    const n = xs.length;
    if (n <= pixels * 2) return { xs, ys };
    const ox = [], oy = [];
    const span = x1 - x0 || 1;
    let bucket = -1, minI = -1, maxI = -1, nanSeen = false;
    const flush = () => {
      if (minI < 0) return;
      const a = Math.min(minI, maxI), b = Math.max(minI, maxI);
      ox.push(xs[a]); oy.push(ys[a]);
      if (b !== a) { ox.push(xs[b]); oy.push(ys[b]); }
    };
    for (let i = 0; i < n; i++) {
      const b = Math.floor(((xs[i] - x0) / span) * pixels);
      if (b !== bucket) { flush(); bucket = b; minI = maxI = -1; }
      if (!Number.isFinite(ys[i])) { if (!nanSeen) { flush(); ox.push(xs[i]); oy.push(NaN); minI = maxI = -1; } continue; }
      if (minI < 0 || ys[i] < ys[minI]) minI = i;
      if (maxI < 0 || ys[i] > ys[maxI]) maxI = i;
    }
    flush();
    return { xs: ox, ys: oy };
  }

  /**
   * spec: {title, xLabel, yLabel, series:[{label, color, xs, ys, lo, hi, dash, width}],
   *        hlines:[{y, label, color}], vlines:[{x, label}], yMin, yMax, xMin, xMax, note}
   */
  function draw(canvas, spec) {
    const dpr = root.devicePixelRatio || 1;
    const W = Math.max(200, canvas.clientWidth || 600), H = Math.max(160, canvas.clientHeight || 300);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    canvas.setAttribute("aria-label", spec.title || "chart");
    const series = (spec.series || []).map((s, k) => ({ ...s, color: s.color || PALETTE[k % PALETTE.length] }));

    // Legend layout first, so the plot area can shrink to fit it.
    ctx.font = SMALL;
    const labelled = series.filter((s) => s.label);
    const legendItems = labelled.length > 1 ? labelled.map((s) => ({ s, w: ctx.measureText(s.label).width + 26 })) : [];
    const legendRows = [];
    let row = [], rowW = 0;
    for (const it of legendItems) {
      if (rowW + it.w > W - 70 && row.length) { legendRows.push(row); row = []; rowW = 0; }
      row.push(it); rowW += it.w;
    }
    if (row.length) legendRows.push(row);

    const top = 26 + legendRows.length * 16;
    const pad = { l: 58, r: 14, t: top, b: 38 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

    ctx.fillStyle = "#111827";
    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(spec.title || "", pad.l, 6);

    let ly = 24;
    ctx.font = SMALL;
    ctx.textBaseline = "middle";
    for (const r of legendRows) {
      let lx = pad.l;
      for (const { s, w } of r) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash(s.dash || []);
        ctx.beginPath(); ctx.moveTo(lx, ly + 2); ctx.lineTo(lx + 18, ly + 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#374151";
        ctx.fillText(s.label, lx + 22, ly + 2);
        lx += w;
      }
      ly += 16;
    }

    // Ranges.
    let xMin = spec.xMin ?? Infinity, xMax = spec.xMax ?? -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of series) {
      for (let i = 0; i < s.xs.length; i++) {
        if (spec.xMin === undefined) xMin = Math.min(xMin, s.xs[i]);
        if (spec.xMax === undefined) xMax = Math.max(xMax, s.xs[i]);
        for (const arr of [s.ys, s.lo, s.hi]) {
          if (arr && Number.isFinite(arr[i])) { yMin = Math.min(yMin, arr[i]); yMax = Math.max(yMax, arr[i]); }
        }
      }
    }
    for (const h of spec.hlines || []) { yMin = Math.min(yMin, h.y); yMax = Math.max(yMax, h.y); }
    if (spec.yMin !== undefined) yMin = spec.yMin;
    if (spec.yMax !== undefined) yMax = spec.yMax;
    const empty = !Number.isFinite(xMin) || !Number.isFinite(yMin);
    if (empty) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }
    const showTicks = !empty;
    if (xMax <= xMin) xMax = xMin + 1;
    if (yMax <= yMin) { const d = Math.abs(yMin) * 0.1 || 0.5; yMin -= d; yMax += d; }
    else if (spec.yMin === undefined || spec.yMax === undefined) {
      const m = (yMax - yMin) * 0.05;
      if (spec.yMin === undefined) yMin -= m;
      if (spec.yMax === undefined) yMax += m;
    }
    const X = (x) => pad.l + ((x - xMin) / (xMax - xMin)) * pw;
    const Y = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * ph;

    // Grid and axes.
    ctx.font = SMALL;
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of niceTicks(yMin, yMax, Math.max(2, Math.floor(ph / 45)))) {
      if (v < yMin || v > yMax) continue;
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      if (showTicks) ctx.fillText(fmtTick(v), pad.l - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const v of niceTicks(xMin, xMax, Math.max(2, Math.floor(pw / 90)))) {
      if (v < xMin || v > xMax) continue;
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      if (showTicks) ctx.fillText(fmtTick(v), x, pad.t + ph + 4);
    }
    ctx.strokeStyle = "#9ca3af";
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, pw, ph);
    ctx.fillStyle = "#374151";
    ctx.fillText(spec.xLabel || "round t", pad.l + pw / 2, H - 16);
    if (spec.yLabel) {
      ctx.save();
      ctx.translate(12, pad.t + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = "middle";
      ctx.fillText(spec.yLabel, 0, 0);
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();

    for (const h of spec.hlines || []) {
      ctx.strokeStyle = h.color || "#6b7280";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      const y = Y(h.y);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    }
    for (const v of spec.vlines || []) {
      ctx.strokeStyle = "#9ca3af";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      const x = X(v.x);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      if (v.label) { ctx.setLineDash([]); ctx.fillStyle = "#6b7280"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(v.label, x + 4, pad.t + 4); }
    }
    ctx.setLineDash([]);

    // Bands.
    for (const s of series) {
      if (!s.lo || !s.hi) continue;
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.16;
      let open = false, start = 0;
      const n = s.xs.length;
      const closeBand = (end) => {
        for (let i = end; i >= start; i--) ctx.lineTo(X(s.xs[i]), Y(s.lo[i]));
        ctx.closePath(); ctx.fill(); open = false;
      };
      for (let i = 0; i < n; i++) {
        const ok = Number.isFinite(s.lo[i]) && Number.isFinite(s.hi[i]);
        if (ok && !open) { ctx.beginPath(); ctx.moveTo(X(s.xs[i]), Y(s.hi[i])); open = true; start = i; }
        else if (ok) ctx.lineTo(X(s.xs[i]), Y(s.hi[i]));
        else if (open) closeBand(i - 1);
      }
      if (open) closeBand(n - 1);
      ctx.globalAlpha = 1;
    }

    // Lines (NaN breaks the line); series marked `front` are drawn last so they stay visible.
    for (const s of [...series.filter((x) => !x.front), ...series.filter((x) => x.front)]) {
      const d = decimate(s.xs, s.ys, xMin, xMax, pw);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.8;
      ctx.setLineDash(s.dash || []);
      ctx.lineJoin = "round";
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < d.xs.length; i++) {
        if (!Number.isFinite(d.ys[i])) { pen = false; continue; }
        const x = X(d.xs[i]), y = Y(d.ys[i]);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
      if (s.markLast && d.xs.length) {
        const i = d.xs.length - 1;
        if (Number.isFinite(d.ys[i])) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(d.xs[i]), Y(d.ys[i]), 3, 0, 2 * Math.PI); ctx.fill(); }
      }
    }
    ctx.setLineDash([]);

    // Reference-line labels on top of the curves, stacked so they never overlap.
    const tags = (spec.hlines || []).filter((h) => h.label).map((h) => ({ h, y: Y(h.y) })).sort((a, b) => a.y - b.y);
    let lastBottom = -Infinity;
    ctx.font = SMALL;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const { h, y } of tags) {
      const w = ctx.measureText(h.label).width + 8;
      let cy = Math.max(y - 9, lastBottom + 8);
      cy = Math.min(Math.max(cy, pad.t + 8), pad.t + ph - 8);
      lastBottom = cy + 7;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillRect(pad.l + pw - 4 - w, cy - 7, w, 14);
      ctx.fillStyle = h.color || "#6b7280";
      ctx.fillText(h.label, pad.l + pw - 8, cy);
    }
    ctx.restore();

    if (empty || spec.note) {
      const text = empty ? (spec.emptyText || "No data yet") : spec.note;
      ctx.font = FONT;
      const tw = Math.min(pw - 8, ctx.measureText(text).width + 16);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(pad.l + pw / 2 - tw / 2, pad.t + ph / 2 - 12, tw, 24);
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, pad.l + pw / 2, pad.t + ph / 2, pw - 16);
    }
  }

  /** Stack several canvases vertically (2 per row) into one PNG data URL. */
  function compositePNG(canvases, title) {
    const visible = canvases.filter((c) => c.width > 0 && c.height > 0);
    if (!visible.length) return null;
    const cols = visible.length > 1 ? 2 : 1;
    const cw = Math.max(...visible.map((c) => c.width)), ch = Math.max(...visible.map((c) => c.height));
    const dpr = root.devicePixelRatio || 1;
    const head = Math.round(30 * dpr);
    const out = document.createElement("canvas");
    out.width = cw * cols;
    out.height = head + ch * Math.ceil(visible.length / cols);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = "#111827";
    ctx.font = `600 ${Math.round(14 * dpr)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(title || "", Math.round(10 * dpr), head / 2);
    visible.forEach((c, k) => ctx.drawImage(c, (k % cols) * cw, head + Math.floor(k / cols) * ch));
    return out.toDataURL("image/png");
  }

  /** Categorical bar chart of probabilities. spec: {bars:[{label, value, color}], xLabel, yLabel}. */
  function bars(canvas, spec) {
    const dpr = root.devicePixelRatio || 1;
    const W = Math.max(200, canvas.clientWidth || 600), H = Math.max(160, canvas.clientHeight || 260);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const items = spec.bars || [];
    const pad = { l: spec.yLabel ? 62 : 46, r: 10, t: 22, b: 42 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const top = Math.max(0.05, ...items.map((b) => b.value)) * 1.12;
    const ticks = niceTicks(0, top, Math.max(2, Math.floor(ph / 45))).filter((v) => v >= 0 && v <= top);
    const Y = (v) => pad.t + (1 - v / top) * ph;
    const pct = (v) => `${+(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

    ctx.font = SMALL;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#eceef1";
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      ctx.fillText(pct(v), pad.l - 6, y);
    }

    const slot = pw / Math.max(1, items.length);
    const bw = Math.max(4, Math.min(56, slot * 0.68));
    items.forEach((b, k) => {
      const cx = pad.l + slot * (k + 0.5);
      if (b.value > 0) {
        const y = Y(b.value), h = Math.max(1, pad.t + ph - y);
        ctx.fillStyle = b.color || PALETTE[0];
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cx - bw / 2, pad.t + ph - h, bw, h, [3, 3, 0, 0]); else ctx.rect(cx - bw / 2, pad.t + ph - h, bw, h);
        ctx.fill();
        if (slot >= 30) {
          ctx.fillStyle = "#374151";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(b.value >= 0.0005 ? `${(b.value * 100).toFixed(1)}%` : "<0.1%", cx, y - 3);
        }
      }
      ctx.fillStyle = "#4b5563";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(b.label, cx, pad.t + ph + 6);
    });

    ctx.strokeStyle = "#9ca3af";
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t + ph + 0.5); ctx.lineTo(pad.l + pw, pad.t + ph + 0.5); ctx.stroke();
    ctx.fillStyle = "#374151";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    if (spec.xLabel) ctx.fillText(spec.xLabel, pad.l + pw / 2, H - 4);
    if (spec.yLabel) {
      ctx.save();
      ctx.translate(12, pad.t + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = "middle";
      ctx.fillText(spec.yLabel, 0, 0);
      ctx.restore();
    }
    canvas.setAttribute("aria-label", spec.ariaLabel || "bar chart");
  }

  root.NFCharts = { draw, bars, compositePNG, PALETTE, niceTicks };
})(typeof globalThis !== "undefined" ? globalThis : this);
