/**
 * Tidy gate: a belt, scored in a sheet's columns, carries rows through a gate. Rows ride in ragged and come
 * out square: under the comb a skewed row is turned straight, a lump (text in a number column) is pressed flat,
 * a blank row collapses to nothing, and a total line, too thick for the teeth, is knocked back and thrown out
 * through a gap in the rail into the bin. Every fix is one line of SQL, and the read-out says which; the gate
 * reads FROM Sheet1. The belt runs all the time (ambient, inside register, so it sleeps offscreen); a choice
 * slows it on a spring to a third, so one fix can be watched. The slider is its speed.
 */
import HL from './kernel.js'

const {
  Cam, EASE_LIFT, clamp, facing, fit, hull, lerp, open, poly, prism, proj, rad, ringAt, rings, run, seg, unproj,
  spring, stepS, tween, tset, tval, reducedMotion, disposer, mk, pointer, put, register, solid,
} = HL;

// the belt (x along it, y across, z up), its rows, the gate at XG (XT: where a total line's face meets the teeth) and the bin
const L = 170, BW = 34, BZ = 5, CY = 17, HX = 4, HY = 12, RT = 1.8, N = 10, XIN = 3, XOUT = L - 3, LB = XOUT - XIN, GAP = LB / N;
const XG = 80, LZ = 13.5, TZ = BZ + RT + 0.9, RAIL = [-1.2, BW + 1.2], XT = XG - HX - 0.4;
const BX0 = 92, BX1 = 108, BY0 = 41, BY1 = 71, BH = 5, XB = 100, YB = 56, ZB = 2.7, FB = rad(-9);
// the cycle of defects (the two rows removed are never neighbours), the SQL each fix is, and where a tall one meets the teeth
const KINDS = ["total", "lump", "blank", "skew", "clean"];
const SQL = { total: "WHERE NOT total_row", blank: "WHERE NOT blank_row", skew: "TRIM(name)", lump: "CAST(amount AS DOUBLE)", clean: "SELECT *" };
const CT = { total: XT, lump: XG - 2.4 }, NONE = { sil: "", crease: "" };
const LR = (p) => (p[0][0] <= p[p.length - 1][0] ? p : p.slice().reverse()); // a run of points, left to right on screen
/** 0 until the belt brings x to x0, then eased to 1 over w units: each fix starts where the row meets the teeth. */
const fixAt = (x, x0, w) => EASE_LIFT(clamp((x - x0) / w, 0, 1));
const sm = (u) => u * u * (3 - 2 * u);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const C = Cam(45, 0.5, 2.05);
  // fitted to the belt's ends and its far rail: the gate, the bin and the throw all stay inside that box
  fit(C, [[-3.4, BW + 1, 3], [L + 3.4, -1, 3], [5, -2, 7.8], [L + 3, BW + 1, 0]], 200, 166);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);
  const block = (x0, y0, x1, y1, r, b, z0, z1, bare) => {
    const [o, i] = rings(x0, y0, x1, y1, r, b), s = solid(g), p = prism(P, front, o, i, z0, z1); put(s, bare ? { sil: p.sil, crease: "" } : p); return s;
  };
  /** A drum roller lying across the belt at x: the hull of its two end circles; the near end's rim is its crease. */
  const drum = (x, cap = (y, r) => Array.from({ length: 24 }, (_, k) => P(x + r * Math.cos((k * Math.PI) / 12), y, 3 + r * Math.sin((k * Math.PI) / 12)))) =>
    put(solid(g), { sil: poly(hull(cap(-1, 3.1).concat(cap(BW + 1, 3.1)))), crease: poly(cap(BW + 1, 2.3)) });
  // the rails and their posts are too thin to hold a crease at 240px: silhouette only
  const posts = (y) => [16, 52, 116, 154].forEach((px) => block(px - 0.8, y - 0.8, px + 0.8, y + 0.8, 0.8, 0.3, 0, 6.4, 1));
  const bar = (y, x0, x1) => block(x0, y - 0.8, x1, y + 0.8, 0.8, 0.3, 6.4, 7.8, 1);

  // Back to front: what stands behind the belt, the belt, its rows, then what stands in front of them.
  // The gate's lintel and comb are higher than anything that rides the belt, so they are painted after every row.
  block(XG - 1.6, -5.6, XG + 1.6, -2.4, 1, 0.5, 0, LZ);
  posts(RAIL[0]); bar(RAIL[0], 5, L - 5);
  block(0, 0, L, BW, 3, 1.2, 0, BZ);
  drum(0);
  posts(RAIL[1]);
  const dl = mk("g", {}, g), rl = mk("g", {}, g); // blank rows' dashed outlines lie on the belt, under the rows
  // the belt is the sheet: two dim column lines along it, which every row's cell marks continue
  mk("path", { class: "nf lo", d: [CY - HY / 3, CY + HY / 3].map((v) => seg(P(XIN + 5, v, BZ), P(XOUT, v, BZ))).join("") }, dl);
  drum(L);
  bar(RAIL[1], 5, 60); bar(RAIL[1], XG, L - 5); // the near rail is cut where the total line is thrown out
  const flyB = mk("g", {}, g); // a thrown row while it is still behind the gate's near post and lintel
  block(XG - 1.6, BW + 2.4, XG + 1.6, BW + 5.6, 1, 0.5, 0, LZ);
  const teeth = mk("path", { class: "nf sil hi" }, g);
  const lintel = block(XG - 2, -5.6, XG + 2, BW + 5.6, 1.2, 0.6, LZ, LZ + 2.6);

  const [ro, ri] = rings(-HX, -HY, HX, HY, 1.4, 0.7), [lo, li] = rings(-2.4, HY / 3 + 1.6, 2.4, HY - 1.6, 1, 0.5);
  /** One slab's frame: centre (cx, cy) resting on z0, turned a about z, tipped f about x, scaled k about its centre, t thick; w is height from its mid-plane. */
  function frame(cx, cy, z0, a, f, k, t) {
    const ca = Math.cos(a), sa = Math.sin(a), cf = Math.cos(f), sf = Math.sin(f), zc = z0 + (k * t) / 2;
    const W = (u, v, w) => { const x = k * (u * ca - v * sa), y = k * (u * sa + v * ca); return P(cx + x, cy + y * cf - k * w * sf, zc + y * sf + k * w * cf); };
    const fr = (q) => front({ ...q, nu: q.nu * ca - q.nv * sa, nv: q.nu * sa + q.nv * ca });
    const at = (ring, w) => ring.map((q) => W(q.u, q.v, w));
    return { W, at, box: (o, i, w0, w1) => ({ sil: poly(hull(at(o, w0).concat(at(o, w1)))), crease: open(at(run(i, fr), w1)) }) };
  }
  /** A row's cell marks, on its top and down its near face, so the sheet's columns still read when small. */
  const marks = (F, t) => [-HY / 3, HY / 3].map((v) => seg(F.W(1 - HX, v, t / 2), F.W(HX, v, t / 2)) + seg(F.W(HX, v, t / 2), F.W(HX, v, -t / 2))).join("");

  // the bin: its far half, the total line in it (which rocks as a new one lands), the one being thrown, then its near wall
  const [bo, bi] = rings(BX0, BY0, BX1, BY1, 3, 1.4);
  mk("path", { d: poly(hull(ringAt(P, bo, 0).concat(ringAt(P, bo, BH)))), class: "sil" }, g);
  mk("path", { d: poly(ringAt(P, bi, BH)), class: "nf" }, g);
  mk("path", { d: open(ringAt(P, run(bi, (q) => !front(q)), 0.8)), class: "nf lo" }, g);
  const binned = solid(g), bm = mk("path", { class: "nf lo" }, binned.g), rock = spring(0);
  const bin = (on = true, F = frame(XB, YB, ZB, 0, FB + rock.x, 1, 2 * RT)) => { put(binned, on ? F.box(ro, ri, -RT, RT) : NONE); bm.setAttribute("d", on ? marks(F, 2 * RT) : ""); };
  const fly = mk("g", {}, g), near = mk("g", {}, g);
  const iF = LR(ringAt(P, run(bi, front), BH)), oT = LR(ringAt(P, run(bo, front), BH)), oB = LR(ringAt(P, run(bo, front), 0));
  [[poly([...iF, oT[oT.length - 1], ...oB.slice().reverse(), oT[0]]), "fo"], [open(oT), "nf lo"], [open(iF), "nf"],
    [open([oT[0], ...oB, oT[oT.length - 1]]), "nf sil"]].forEach(([d, c]) => mk("path", { d, class: c }, near));

  // the comb: a row too tall for the gap knocks it, and the bump spreads out from the tooth it hit, 35ms a tooth
  const tt = [0, 1, 2, 3, 4, 5].map(() => tween(0));
  let flip = 0, tkey = "";
  const ripple = (kc, now) => { flip = 1 - flip; tt.forEach((w, k) => tset(w, flip, now, Math.abs(k - kc) * 35)); };
  const drawTeeth = (now, d = tt.map((w, k) => seg(P(XG, 5 + k * 4.8, LZ), P(XG, 5 + k * 4.8, TZ + 1.2 * Math.sin(Math.PI * tval(w, now))))).join("")) =>
    d !== tkey && teeth.setAttribute("d", (tkey = d));

  let phase = 8, base = value, over = null, act = -2, fl = -1, follow = false, fp = null;
  // settled where the belt has them at mount, in x order; a total line already past the teeth is in the bin
  const rows = KINDS.concat(KINDS).map((kind, i) => {
    const rg = mk("g", {}, rl), x = XIN + ((phase + i * GAP) % LB);
    return { i, kind, x, g: rg, s: solid(rg), m: mk("path", { class: "nf lo" }, rg), l: solid(rg), dash: mk("path", { class: "nf dash" }, dl),
      st: kind === "total" && x >= XT ? "bin" : "belt", hit: !(x < CT[kind]), key: "", on: false, up: false, front: false };
  });

  /** Row r where the belt has carried it: the comb fixes its defect as it passes the teeth. */
  function drawRow(r, now) {
    const x = XIN + ((((phase + r.i * GAP) % LB) + LB) % LB);
    if (x < r.x - LB / 2) { r.st = "belt"; r.front = false; r.hit = !CT[r.kind]; rl.prepend(r.g); } // wrapped to the entry: its defect comes back
    r.x = x;
    if (!r.hit && x >= CT[r.kind]) { r.hit = true; ripple(r.kind === "lump" ? 4 : 2.5, now); }
    const k = EASE_LIFT(clamp(Math.min(x - XIN, XOUT - x) / 4, 0, 1)); // rows come up over the far drum and go down over the near one
    let cx = x, cy = CY, z0 = BZ, a = 0, f = 0, t = RT, lump = 0, kk = k;
    if (r.kind === "skew") a = rad(12) * (1 - fixAt(x, XG - 6.5, 6.5)); // from its corner meeting the teeth to its centre under them
    if (r.kind === "lump") lump = 2.6 * (1 - fixAt(x, XG - 3.8, 6.2)); // no taller than the gap by the time its face is under the teeth
    if (r.kind === "blank") kk = k * clamp(1.2 * (1 - fixAt(x, XG - HX, 8)) - 0.2, 0, 1);
    if (r.kind === "total") {
      t = 2 * RT;
      // thrown: a pointer on it rides with it into the bin, and keeps the bin until it moves away
      if (r.st === "belt" && x >= XT) { r.st = "fly"; r.t0 = now; r.cover = false; fl = r.i; if (act === r.i) { follow = true; fp = over; } flyB.append(r.g); }
      if (r.st === "fly") {
        // A thrown body is not eased: the flight takes the house 700ms on its own clock, and gravity shapes its height.
        // Knocked back off the teeth, out through the rail's gap clear of the post, along over the bin's wall, then down.
        const s = clamp((now - r.t0) / 700, 0, 1);
        cx = XT - 3.4 * Math.sin(Math.PI * Math.min(1, s / 0.5)) + (XB - XT) * sm(clamp((s - 0.3) / 0.5, 0, 1));
        cy = lerp(CY, YB, 1 - (1 - clamp((s - 0.08) / 0.42, 0, 1)) ** 2);
        z0 = lerp(BZ, ZB, s * s) + 13.5 * s * (1 - s);
        f = FB * sm(s) - rad(24) * Math.sin(Math.PI * clamp((s - 0.12) / 0.4, 0, 1));
        if (!r.front && cy - HY > BW + 5.6) { r.front = true; fly.append(r.g); } // past the post and the lintel's end
        const up = z0 + RT - HY * Math.abs(Math.sin(f)) - RT * Math.cos(f) > BH; // lowest edge above the rim: before the near wall
        if (up !== r.up) { r.up = up; if (up) near.after(fly); else near.before(fly); }
        if (s > 0.8 && !r.cover) { r.cover = true; bin(false); } // over the slab in the bin: one slab, the one landing
        if (s === 1) { r.st = "bin"; fl = -1; rock.v = -1.2; }
      }
    }
    r.on = r.st === "belt" && kk > 0.3;
    const hide = r.st === "bin" || kk < 0.02;
    const key = hide ? "gone" : [cx, cy, z0, a, f, kk, lump].map((n) => n.toFixed(2)).join();
    if (key === r.key) return; // nothing moved: keep the paths last drawn
    r.key = key;
    const F = frame(cx, cy, z0, a, f, kk, t);
    if (r.kind === "blank") { r.dash.setAttribute("d", hide ? "" : poly(F.at(ro, -t / 2))); return; }
    put(r.s, hide ? NONE : F.box(ro, ri, -t / 2, t / 2));
    r.m.setAttribute("d", hide ? "" : marks(F, t));
    put(r.l, hide || lump < 0.15 ? NONE : F.box(lo, li, t / 2, t / 2 + lump));
  }

  /**
   * What is under the pointer: the bin, the gate's lintel, or the row nearest it along the belt. Rows move with the belt,
   * so the pick reads where each row is now, on the rows' top plane (unproj at their height); but a choice only slows the
   * belt and never moves a row out from under the pointer, so it cannot flicker: it hands on only as the belt carries the
   * next row under a still pointer. At the comb it skips rows the lintel hides; a row held when thrown keeps the bright.
   */
  function pick() {
    if (!over) return -1;
    const b = unproj(C, over[0], over[1], BH), t = unproj(C, over[0], over[1], LZ + 1.3), q = unproj(C, over[0], over[1], BZ + RT);
    if (follow || (b[0] > BX0 - 5 && b[0] < BX1 + 3 && b[1] > BY0 - 3 && b[1] < BY1 + 3)) return fl >= 0 ? fl : N;
    if (Math.abs(t[0] - XG) < 3.6 && t[1] > -7 && t[1] < BW + 7) return -3;
    if (q[1] < -8 || q[1] > BW + 16 || q[0] < -4 || q[0] > L + 4) return -1;
    const min = Math.abs(q[0] - XG) < 8 ? XT - 2 : -Infinity;
    let best = -1, bd = 2 * GAP;
    rows.forEach((r, i) => { const d = Math.abs(r.x - q[0]); if (r.on && r.x >= min && d < bd) { bd = d; best = i; } });
    return best;
  }

  /** The bright goes to what is picked (the gate lights its lintel and keeps its comb); at rest it is back on the teeth. */
  function light(a) {
    rate.t = a === -1 ? base : base / 3; // anything chosen slows the belt to a crawl
    if (a === act) return;
    act = a;
    rows.forEach((r, i) => [r.s.sil, r.l.sil, r.dash].forEach((e) => e.classList.toggle("hi", i === a)));
    binned.sil.classList.toggle("hi", a === N);
    teeth.classList.toggle("hi", a < 0);
    lintel.sil.classList.toggle("hi", a === -3);
    read.textContent = a === -1 ? "rest" : a === -3 ? "FROM Sheet1" : a === N ? SQL.total : SQL[rows[a].kind];
  }

  const rate = spring(base);
  bin(); drawTeeth(performance.now());
  const B = register(stage, (dt, now) => {
    const still = reducedMotion(); // asked for less motion: the belt stands, composed, and the fixes still read
    if (!still) { stepS(rate, dt); phase += rate.x * dt; }
    rows.forEach((r) => drawRow(r, now));
    if (stepS(rock, dt)) bin();
    drawTeeth(now);
    light(pick());
    return !still;
  });
  bag.add(B.unregister);
  bag.add(pointer(stage, {
    move: (p) => { over = p; if (fl < 0 && follow && Math.hypot(p[0] - fp[0], p[1] - fp[1]) > 4) follow = false; light(pick()); B.wake(); },
    leave: () => { over = null; follow = false; light(-1); B.wake(); },
  }));
  bag.add(() => svg.replaceChildren());
  return { set: (v) => { base = v; B.wake(); }, destroy: bag.dispose };
}

export default {
  name: "tidy-gate",
  means: "Rows ride a belt through a gate and come out square; every fix the comb makes is one line of SQL.",
  rules: [1, 2, 4, 7, 8],
  range: [4, 7, 11],
  tour: [[142, 129], [193, 138], [165, 200], null],
  mount,
};
