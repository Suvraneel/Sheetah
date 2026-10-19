/**
 * Sheet to chart: a spreadsheet lying on the desk as a thin rounded slab, eight month columns by five category
 * rows, with header cells along the far edge, row numbers down the left and the frozen corner. The cells near the
 * pointer rise into bars of their own values, each on its own spring, so what stands up is the data. A dashed
 * marquee on the cells' tops selects what the pointer asks for: the column under it, a column from its header, a
 * row from its number, the table from the corner; it moves on the 700ms tween once the hand settles, and the
 * selected bars above half of the tallest take the bright stroke. At rest one column stands as a chart. The
 * read-out is the selection's SQL. The slider is the lens radius, in cells.
 */
import HL from './kernel.js'

const {
  Cam, clamp, facing, fit, hull, open, prism, proj, ringAt, rings, rrect, unproj, spring, stepS,
  tween, tset, tval, tdone, reducedMotion, mk, pointer, put, register, disposer, solid,
} = HL;

const NC = 8, NR = 5, CELL = 14, FOOT = 11.8, GAP = (CELL - FOOT) / 2, EW = NC * CELL, EH = NR * CELL;
const LIP = 8.4, LZ = 3.8, LZP = 1.8, PLATE = 0.5, SL = 3.6, MF = 2.6, MN = 8.4, RR = 0.7;
const HMAX = 47, REST = 0.68, RC = 6, FLOOR = 0.09, XW = 1.7, YW = 0.4, TF = 0.4, STEP = 30;
const MZ = PLATE + 0.15, TAB = 6.4, DWELL = 90;
const X0 = -LIP - MF, Y0 = -LIP - MF, X1 = EW + MN, Y1 = EH + MN;

// The data: months rise with one dip (E); categories differ in size and in how fast they grow.
const TREND = [0.2, 0.34, 0.47, 0.6, 0.5, 0.72, 0.86, 1];
const BASE = [18400, 13100, 9300, 6400, 4100], GROW = [1.2, 1.05, 1, 0.85, 0.8];
const VAL = BASE.map((b, j) => TREND.map((t) => Math.round((b * t ** GROW[j]) / 10) * 10));
const VMAX = VAL[0][NC - 1], LETTER = "ABCDEFGH", fmt = (n) => n.toLocaleString("en-US");
const SUM = TREND.map((_, i) => VAL.reduce((s, row) => s + row[i], 0)), RSUM = VAL.map((row) => row.reduce((a, b) => a + b, 0));

/** The share of a bar's own height at u lens radii: whole to 15%, then a cosine down to the floor at the edge and beyond. */
const falloff = (u) => (u <= 0.15 ? 1 : u >= 1 ? FLOOR : FLOOR + (1 - FLOOR) * 0.5 * (1 + Math.cos((Math.PI * (u - 0.15)) / 0.85)));
/** Whether screen point p is inside the convex polygon q: on one side of every edge. */
const inside = (p, q) => {
  const s = q.map((a, k) => { const b = q[(k + 1) % q.length]; return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); });
  return s.every((v) => v >= 0) || s.every((v) => v <= 0);
};
// What a world point on the sheet asks for: the corner is the table, the header a column, the gutter a row, a cell its column.
const modeOf = (w) => !w ? { kind: "rest", k: RC } : w[0] < 0 && w[1] < 0 ? { kind: "all", k: 0 }
  : w[1] < 0 ? { kind: "col", k: clamp(Math.floor(w[0] / CELL), 0, NC - 1) }
  : w[0] < 0 ? { kind: "row", k: clamp(Math.floor(w[1] / CELL), 0, NR - 1) }
  : { kind: "cell", k: clamp(Math.floor(w[0] / CELL), 0, NC - 1) };
const rectOf = (s) => s.kind === "row" ? [0, s.k * CELL, EW + TAB, (s.k + 1) * CELL]
  : s.kind === "all" ? [0, 0, EW + TAB, EH + TAB] : [s.k * CELL, 0, (s.k + 1) * CELL, EH + TAB];
const say = (s) => s.kind === "rest" ? "rest" : s.kind === "all" ? "SELECT * FROM sheet"
  : s.kind === "row" ? `WHERE row=${s.k + 1} ${fmt(RSUM[s.k])}` : `SELECT SUM(${LETTER[s.k]}) ${fmt(SUM[s.k])}`;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const C = Cam(45, 0.5, 2.0);
  const restTop = VAL.map((row, j) => [(RC + 0.5) * CELL, (j + 0.5) * CELL, PLATE + (row[RC] / VMAX) * HMAX * REST]);
  fit(C, [[X0, Y0, -SL], [X1, Y1, -SL], [X1, Y0, -SL], [X0, Y1, -SL], [-LIP, -LIP, LZ], ...restTop], 200, 166);
  const P = proj(C), front = facing(C);
  let R = value, over = null, held = null, kind = "rest";

  const g = mk("g", {}, svg);
  const [sr, si] = rings(X0, Y0, X1, Y1, 5, 1.2);
  put(solid(g), prism(P, front, sr, si, -SL, 0));

  // The frame of the sheet, farthest first: the frozen corner, then the header cells and the row numbers, one solid each.
  const strips = [];
  const strip = (x0, y0, x1, y1) => {
    const [ring, inner] = rings(x0, y0, x1, y1, RR, 0.8), s = { ring, inner, box: [x0, y0, x1, y1], z: LZ, el: solid(g) };
    put(s.el, prism(P, front, ring, inner, 0, LZ));
    return strips.push(s) && s;
  };
  const corner = strip(-LIP, -LIP, -GAP, -GAP), ct = tween(LZ);
  for (let k = 0; k < NC; k++) { strip(k * CELL + GAP, -LIP, (k + 1) * CELL - GAP, -GAP); if (k < NR) strip(-LIP, k * CELL + GAP, -GAP, (k + 1) * CELL - GAP); }

  // The body: one low plate per cell, diagonal by diagonal from the far corner, so appending is painting back to
  // front. Each cell sits between two pieces of the marquee: the runs in the gaps behind it, and the runs on its top.
  const cells = [], grid = [];
  for (let s = 0; s <= NC + NR - 2; s++) for (let i = 0; i < NC; i++) {
    const j = s - i;
    if (j < 0 || j >= NR) continue;
    const v = VAL[j][i], h0 = PLATE + (i === RC ? (v / VMAX) * HMAX * REST : 0), box = [i * CELL + GAP, j * CELL + GAP, (i + 1) * CELL - GAP, (j + 1) * CELL - GAP];
    const [ring, inner] = rings(...box, RR, 0.7), mq = mk("path", { class: "dash sil nf" }, g);
    const c = { i, j, v, h0, box, ring, inner, mq, el: solid(g), t: h0 - PLATE, at: 0, pend: h0, hot: false, on: false, sp: spring(h0, { eps: 0.03 }), drawn: NaN };
    c.mb = mk("path", { class: "dash sil nf" }, g); cells.push(c); grid[j * NC + i] = c;
  }
  const frontMq = mk("path", { class: "dash sil nf" }, g), mqs = cells.flatMap((c) => [c.mq, c.mb]).concat(frontMq), mqD = new Map();
  const top = cells.reduce((a, b) => (b.h0 > a.h0 ? b : a));

  // The marquee, on the cells' tops: each run of it goes to the slot just before the first cell in front of it.
  // A run that crosses a cell mid-tween lies on it while it is flat, and under it once it stands.
  const slotOf = (x, y, vert) => {
    const i = Math.floor(x / CELL + (vert ? GAP / CELL : 0)), j = Math.floor(y / CELL + (vert ? 0 : GAP / CELL)), c = grid[j * NC + i];
    if (x > EW || y > EH || i >= NC || !c) return frontMq;
    return x > c.box[0] && x < c.box[2] && y > c.box[1] && y < c.box[3] && c.sp.x <= MZ ? c.mb : c.mq;
  };
  const mt = rectOf({ kind: "rest", k: RC }).map((v) => tween(v));
  let selKey = "", selRect = null, selSince = 0, mKey = "", mDrawn = "", cDrawn = LZ;
  function drawMarq(now) {
    const r = mt.map((tw) => tval(tw, now)), key = r.join();
    if (key === mDrawn) return;
    mDrawn = key;
    const ring = rrect(r[0], r[1], r[2], r[3], 1.6, 3), pts = [], out = new Map();
    ring.forEach((a, n) => {
      const b = ring[(n + 1) % ring.length], k = Math.max(1, Math.ceil(Math.hypot(b.u - a.u, b.v - a.v) / 1.4));
      for (let q = 0; q < k; q++) pts.push([a.u + ((b.u - a.u) * q) / k, a.v + ((b.v - a.v) * q) / k]);
    });
    let run = null, at = null;
    pts.forEach((a, n) => {
      const b = pts[(n + 1) % pts.length], el = slotOf((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]));
      if (el !== at) { at = el; run = [P(a[0], a[1], MZ)]; out.set(el, (out.get(el) || []).concat([run])); }
      run.push(P(b[0], b[1], MZ));
    });
    for (const el of mqs) {
      const d = (out.get(el) || []).map(open).join("");
      if (mqD.get(el) !== d) { mqD.set(el, d); el.setAttribute("d", d); }
    }
  }

  // A bar whose spring hasn't moved keeps its paths; a flat cell is a plate with no crease. The bright stroke goes
  // to the selected bars above half of the tallest of them on this frame; at rest, to the mark once it is half back up.
  function drawCell(c, peak) {
    const h = c.sp.x;
    const pr = h !== c.drawn && prism(P, front, c.ring, c.inner, 0, Math.max(PLATE, h));
    if (pr) { c.drawn = h; put(c.el, h < PLATE + 2 ? { sil: pr.sil, crease: "" } : pr); }
    const on = c.hot && peak > 2 && h - PLATE >= 0.5 * (kind === "rest" ? c.t : peak);
    if (on !== c.on) { c.on = on; c.el.sil.classList.toggle("hi", on); }
  }

  const B = register(stage, (dt, now) => {
    if (selKey !== mKey && now - selSince >= (reducedMotion() ? 0 : DWELL)) { mt.forEach((tw, q) => tset(tw, selRect[q], now, 0)); mKey = selKey; }
    let m = selKey !== mKey || !tdone(ct, now) || mt.some((tw) => !tdone(tw, now)), peak = 0;
    for (const c of cells) {
      if (c.at && now >= c.at) { c.sp.t = c.pend; c.at = 0; }
      if (stepS(c.sp, dt) || c.at) m = true;
      if (c.hot) peak = Math.max(peak, c.sp.x - PLATE);
    }
    for (const c of cells) drawCell(c, peak);
    drawMarq(now);
    if (tval(ct, now) !== cDrawn) { cDrawn = tval(ct, now); put(corner.el, prism(P, front, corner.ring, corner.inner, 0, cDrawn)); }
    return m;
  });
  bag.add(B.unregister);

  function retarget(now) {
    const s = modeOf(over), fresh = s.kind !== kind, still = reducedMotion();
    for (const c of cells) {
      let d = 0;
      if (s.kind === "rest") { c.t = c.h0 - PLATE; c.hot = c === top; if (c.i === RC) d = 140 + 35 * (NR - 1 - c.j); }
      else {
        let f = 1;
        if (s.kind === "cell") {
          const u = Math.hypot((c.i - s.k) * XW, (c.j + 0.5 - over[1] / CELL) * YW);
          f = falloff(u / R); d = STEP * Math.min(4, u);
        } else if (s.kind === "all") { f = TF; d = STEP * (c.i + c.j); }
        else if (s.kind === "col") { f = c.i === s.k ? 1 : FLOOR; d = STEP * c.j; }
        else { f = c.j === s.k ? 1 : FLOOR; d = STEP * c.i; }
        c.t = clamp((c.v / VMAX) * HMAX * f, 0, HMAX);
        c.hot = s.kind === "all" || (s.kind === "row" ? c.j === s.k : c.i === s.k && f > 0.2);
      }
      // The rise ripples out from where the hand came in; while the selection keeps its kind, the bars follow at once.
      if (fresh) c.at = d && !still ? now + d : 0;
      if (c.at) c.pend = PLATE + c.t; else c.sp.t = PLATE + c.t;
    }
    kind = s.kind;
    corner.z = s.kind === "all" ? LZP : LZ;
    tset(ct, corner.z, now, 0);
    const r = rectOf(s), key = r.join();
    if (key !== selKey) { selKey = key; selRect = r; selSince = now; }
    read.textContent = say(s);
    B.wake();
  }

  // The hit, rule 01: every part at its target pose, front to back, so a pointer on a risen bar picks that bar. The
  // part picked last is tested first: it keeps the pointer while it is on it, so a bar its own answer raises in front
  // never takes the pointer away from it, and nothing can flip back and forth.
  const onSheet = (w) => w[0] > X0 - 4 && w[0] < X1 + 4 && w[1] > Y0 - 4 && w[1] < Y1 + 4;
  const into = (b, w) => [clamp(w[0], b[0], b[2]), clamp(w[1], b[1], b[3])];
  const under = (p, ring, z) => inside(p, hull(ringAt(P, ring, 0).concat(ringAt(P, ring, z))));
  function hit(p) {
    const zOf = (q) => q.z ?? PLATE + q.t;
    for (const q of [held, ...[...cells].reverse(), ...[...strips].reverse()]) if (q && under(p, q.ring, zOf(q))) return [into(q.box, unproj(C, p[0], p[1], zOf(q))), q];
    const w = unproj(C, p[0], p[1], 0);
    return [onSheet(w) ? w : null, null];
  }
  bag.add(pointer(stage, {
    move: (p) => { [over, held] = hit(p); retarget(performance.now()); },
    leave: () => { over = held = null; retarget(performance.now()); },
  }));
  bag.add(() => svg.replaceChildren());
  retarget(performance.now());
  mKey = selKey;

  return {
    set: (v) => { R = v; if (over) retarget(performance.now()); },
    destroy: bag.dispose,
  };
}

export default {
  name: "sheet-chart",
  means: "A spreadsheet lying flat: the cells you point at rise into bars of their own values, and the SQL of the selection answers.",
  rules: [1, 3, 4, 8],
  range: [1.4, 2.2, 3.4],
  tour: [[112, 162], [249, 190], [309, 180], null],
  mount,
};
