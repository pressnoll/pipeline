/* ============================================================================
   telemetry.js — hydraulic + edge-AI simulator
   ----------------------------------------------------------------------------
   THIS FILE IS THE ONLY PLACE THAT INVENTS DATA.

   The production database (Firebase / ThingSpeak) is not connected yet, so this
   module stands in for it. It is not a random-number generator dressed up as
   telemetry: it runs a small hydraulic model of the segment (Hazen-Williams
   headloss, orifice discharge, flow continuity) and derives every sensor
   reading from that model, so the numbers on the dashboard agree with each
   other the way real instrument readings do.

   The reverse path is modelled too: the dashboard never sees the simulator's
   internal truth. It reads the *instruments*, then re-estimates leak rate and
   leak position from those noisy readings — which is why the localisation
   result carries an uncertainty that widens for small leaks.

   To go live, replace `pushFrame`'s caller with a subscription to the real
   feed and keep the frame shape below. Nothing downstream changes.

   Frame shape
   -----------
   { t, nodes: { A|B|C: { … } }, sys: { … } }
   ========================================================================== */

const Telemetry = (function () {
  'use strict';

  /* ── segment definition ────────────────────────────────────────────────── */

  const SEG = {
    id: 'WB-04',
    label: 'Ring Rd → Eleyele',
    length: 1240,          // m
    dn: 150,               // nominal bore, mm
    hazenC: 110,
    tariff: 285,           // ₦ per m³
    qNominal: 1040,        // L/min at design demand
    supply: 3.40           // bar at the inlet header
  };

  const NODES = [
    { id: 'A', name: 'Ring Rd inlet',     x: 0,    lat: 7.37751, lon: 3.94702, rssi: -58, pdr: 99.9, uptime: 99.94, infP50: 11, infP95: 15 },
    { id: 'B', name: 'Awolowo midpoint',  x: 620,  lat: 7.38145, lon: 3.95098, rssi: -67, pdr: 99.4, uptime: 99.61, infP50: 12, infP95: 17 },
    { id: 'C', name: 'Eleyele outlet',    x: 1240, lat: 7.38539, lon: 3.95494, rssi: -73, pdr: 98.7, uptime: 98.92, infP50: 12, infP95: 18 }
  ];

  const CLASSES = ['normal', 'minor', 'major'];

  /* Headloss coefficient, bar per metre at design flow.
     Hazen-Williams over 1,240 m of DN150 at 1,040 L/min ≈ 12.3 m ≈ 1.21 bar. */
  const K_BAR_PER_M = 1.21 / SEG.length;

  /* BMP280 drifts with ambient temperature; the node subtracts this. */
  const TEMP_COEFF = 0.0042;    // bar per °C away from the 25 °C calibration
  const MOIST_RADIUS = 90;      // a joint sensor only wets within this radius
  const CONFIRM_WINDOWS = 4;    // consecutive agreeing inferences before alerting

  /* ── deterministic noise ───────────────────────────────────────────────── */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0x5EED17);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.7071; // ≈N(0,1)
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ── demand curve ──────────────────────────────────────────────────────── */

  /* Two-hump municipal diurnal profile: morning draw, evening draw, night lull. */
  function demandFactor(tsMs) {
    const h = ((tsMs / 3600000) % 24 + 1) % 24;   // WAT = UTC+1
    const hump = (c, w, a) => a * Math.exp(-Math.pow((h - c) / w, 2));
    return 1 + hump(7, 1.9, 0.13) + hump(19, 2.3, 0.10) - hump(3.5, 2.6, 0.10);
  }

  /* ── leak schedule ─────────────────────────────────────────────────────── */

  /* Historical events used to backfill 24 h so the long windows are not empty.
     Offsets are seconds before "now". */
  const HISTORY = [
    { from: -66600, to: -64980, peak: 84,  pos: 402, ramp: 240, label: 'minor' },
    { from: -15600, to: -13140, peak: 261, pos: 951, ramp: 300, label: 'major' }
  ];

  /* Live auto-cycle: normal → minor → major → repaired → suppressed transient. */
  const CYCLE = 264;
  const CYCLE_POS = [868, 402];

  function autoLeak(cycleT, pos) {
    const ramp = (t, t0, t1) => clamp((t - t0) / (t1 - t0), 0, 1);
    let q = 0;
    if (cycleT >= 58 && cycleT < 140)       q = 82 * ramp(cycleT, 58, 78);
    else if (cycleT >= 140 && cycleT < 214) q = 82 + (268 - 82) * ramp(cycleT, 140, 162);
    else if (cycleT >= 214 && cycleT < 242) q = 268 * (1 - ramp(cycleT, 214, 240));
    // a 2 s mechanical transient — a valve slam, not a leak. Must be suppressed.
    const transient = cycleT >= 250 && cycleT < 252.5;
    return { q, pos, transient };
  }

  function historyLeakAt(offsetSec) {
    for (const ev of HISTORY) {
      if (offsetSec < ev.from || offsetSec > ev.to) continue;
      const up = clamp((offsetSec - ev.from) / ev.ramp, 0, 1);
      const dn = clamp((ev.to - offsetSec) / ev.ramp, 0, 1);
      return { q: ev.peak * Math.min(up, dn), pos: ev.pos, transient: false };
    }
    return { q: 0, pos: 0, transient: false };
  }

  /* ── forward model: truth → instrument readings ─────────────────────────
     Continuity: what enters is what leaves plus what escapes.
       Q_A = demand + q_leak      (inflow rises when a leak opens)
       Q_C = demand               (customers draw the same)
       Q_B = Q_A minus the leak if the leak sits upstream of B
     Pressure: friction over each length carrying its own flow, plus a local
     sag across the orifice itself.                                          */

  function frictionFactor(q) { return Math.pow(Math.max(q, 1) / SEG.qNominal, 1.852); }

  function pressureAt(x, pIn, qUp, qDn, leakPos, leakQ) {
    const fUp = frictionFactor(qUp);
    const fDn = frictionFactor(qDn);
    const hasLeak = leakQ > 1;
    if (!hasLeak) return pIn - K_BAR_PER_M * x * fUp;
    const upLen = Math.min(x, leakPos);
    const dnLen = Math.max(0, x - leakPos);
    const sag = x >= leakPos ? 0.058 * Math.pow(leakQ / 100, 1.3) : 0;
    return pIn - K_BAR_PER_M * upLen * fUp - K_BAR_PER_M * dnLen * fDn - sag;
  }

  /* Wetted-soil state carries across samples, so it lives outside the model. */
  const moistState = { A: 5.2, B: 4.6, C: 5.9 };

  function buildSample(tsMs, leak, dtSec, prev) {
    const dFac = demandFactor(tsMs);
    const temp = 25.4 + 5.6 * Math.max(0, Math.sin((((tsMs / 3600000) % 24) - 7) / 24 * 2 * Math.PI)) + gauss() * 0.22;
    const demand = SEG.qNominal * dFac * (1 + gauss() * 0.004);

    const leakQ = leak.q;
    const leakPos = leak.pos;
    const qA = demand + leakQ;
    const qC = demand;
    const qB = leakPos < NODES[1].x ? qC : qA;

    const pIn = SEG.supply + gauss() * 0.012 - (dFac - 1) * 0.18;
    const blip = leak.transient ? 0.075 : 0;

    const s = { t: tsMs, temp: temp, leakTrue: leakQ, leakPosTrue: leakPos };

    NODES.forEach(function (n, i) {
      const qTrue = i === 0 ? qA : i === 1 ? qB : qC;
      const pTrue = pressureAt(n.x, pIn, qA, qC, leakPos, leakQ) - (n.x > 0 ? blip : 0);

      /* BMP280: temperature-induced offset, then the node's own correction. */
      const offset = TEMP_COEFF * (temp - 25);
      const pRaw = pTrue + offset + gauss() * 0.0055;
      s['pRaw' + n.id] = pRaw;
      s['pOff' + n.id] = offset;
      s['p' + n.id] = pRaw - offset;

      /* YF-S201: pulse counting. The absolute accuracy of these meters is poor
         (±10 %), but a leak is found from the *difference* between two of them,
         and their short-term repeatability once calibrated against each other
         is far tighter than their absolute error. That repeatability is what
         sets the detectable leak floor, so it is what is modelled here. */
      s['q' + n.id] = qTrue * (1 + gauss() * 0.0013) + gauss() * 0.28;

      /* MPU-6050: flow-borne baseline plus jet excitation decaying with range. */
      const base = 10.5 + 4.2 * frictionFactor(qTrue) + Math.abs(gauss()) * 1.6;
      const jet = leakQ > 1 ? 52 * Math.pow(leakQ / 100, 0.8) * Math.exp(-Math.abs(n.x - leakPos) / 210) : 0;
      s['v' + n.id] = base + jet + (leak.transient ? 34 + Math.abs(gauss()) * 8 : 0);

      /* Capacitive moisture at the joint — only wets if the leak is close.
         The relaxation carries the *clean* state forward; sensor noise is added
         to the reading only. Feeding the noisy reading back would compound a
         strictly-positive term into an upward drift. */
      const near = leakQ > 15 && Math.abs(n.x - leakPos) <= MOIST_RADIUS;
      const target = near ? clamp(38 + 52 * (leakQ / 260), 0, 96) : 4.4 + i * 0.6;
      const tau = near ? 42 : 150;
      moistState[n.id] += (target - moistState[n.id]) * (1 - Math.exp(-dtSec / tau));
      s['m' + n.id] = Math.max(0, moistState[n.id] + gauss() * 0.45);

      s['rssi' + n.id] = n.rssi + gauss() * 2.1;
    });

    return s;
  }

  /* ── the classifier ─────────────────────────────────────────────────────
     A KNN vote reproduced faithfully enough to be worth showing: five features
     are compared against three class centroids, the five nearest training
     neighbours vote, and confidence is the winning share of those five. The
     dashboard shows the vote split, not a fabricated percentage.            */

  /* Centroids are calibrated to what *this* array can actually observe, which is
     not the same as what a leak emits:

     · pressure deficit — a 268 L/min leak on 1,240 m of DN150 costs about 9 %
       of supply head at the outlet, and 84 L/min costs about 2.5 %. The textbook
       figures this started from (16.5 % / 5.5 %) belong to a smaller-bore or
       longer main and no leak this pipe can carry ever reached them.
     · vibration — the jet peaks near 112 mg at 268 L/min, but decays with
       exp(-d/210) and the nearest of only three nodes is usually 200-400 m off,
       so a node reads about 52 mg, never the 118 mg emitted at the orifice.
     · dP/dt — a rate of change exists only while a leak is opening. Once flow
       settles the term returns to zero, so a large value here cannot be part of
       what defines a *sustained* major leak; it is widened and pulled in so it
       still separates a burst from slow thermal drift without dominating.
     · moisture — three instrumented joints over 1,240 m means most leak
       positions wet nothing at all. Moisture must therefore be able to confirm
       a leak but never to veto one, so its scale is deliberately loose.

     Before this calibration a confirmed 266 L/min burst classified as *minor*,
     because the unreachable vibration and moisture centroids pulled it there. */
  const CENTROIDS = {
    normal: [0.000, 0.00, 12, 0.2, 5],
    minor:  [0.025, 0.05, 30, 6.0, 18],
    major:  [0.090, 0.12, 55, 21.0, 34]
  };
  const FEAT_SCALE = [0.05, 0.18, 40, 6, 60];

  function features(node, cur, hist) {
    const id = node.id;
    const win = hist.slice(-10);
    const pBar = win.reduce((a, s) => a + s['p' + id], 0) / Math.max(win.length, 1);

    /* Expected pressure at this node if every litre entering the segment were
       being delivered — so the reference is the *outlet* meter, not the inlet.
       Referencing the inlet instead makes this feature inert: a leak raises the
       inlet flow, the reference profile sags by the same headloss the leak
       itself caused, and the deviation cancels to nearly zero exactly when it
       should be largest. Delivered flow is customer demand and is untouched by
       the leak, so the deficit it yields is the leak's own headloss. */
    const expected = SEG.supply - K_BAR_PER_M * node.x * frictionFactor(cur.qC_meas);
    const devP = clamp((expected - pBar) / SEG.supply, -0.4, 0.6);

    const first = win[0] || cur.s;
    const span = Math.max((cur.s.t - first.t) / 60000, 1 / 60);
    const dPdt = clamp((first['p' + id] - cur.s['p' + id]) / span, -1, 1);

    const vib = cur.s['v' + id];
    const imbal = id === 'A' ? cur.imbalAB : id === 'B' ? Math.max(cur.imbalAB, cur.imbalBC) : cur.imbalBC;
    const imbalPct = clamp(imbal / Math.max(cur.qA_meas, 1) * 100, -2, 40);
    const moist = cur.s['m' + id];

    return [devP, dPdt, vib, imbalPct, moist];
  }

  /* Largest-remainder apportionment of k=5 neighbours across the classes. */
  function knn(f) {
    const d = CLASSES.map(function (c) {
      let sum = 0;
      CENTROIDS[c].forEach(function (mu, i) {
        const z = (f[i] - mu) / FEAT_SCALE[i];
        sum += z * z;
      });
      return Math.sqrt(sum);
    });
    const w = d.map(v => 1 / Math.pow(v + 0.35, 3));
    const tot = w.reduce((a, b) => a + b, 0);
    const share = w.map(v => v / tot * 5);

    const votes = share.map(Math.floor);
    let left = 5 - votes.reduce((a, b) => a + b, 0);
    const order = share.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
    for (let i = 0; left > 0; i++, left--) votes[order[i % 3][1]]++;

    let best = 0;
    for (let i = 1; i < 3; i++) if (votes[i] > votes[best]) best = i;
    /* A tie goes to the nearer centroid, never to whichever class happens to sit
       earlier in CLASSES. Array order silently favoured the *less* severe class,
       so a leak sitting midway between the minor and major prototypes — which is
       exactly where a 2/2 split comes from — was downgraded by an accident of
       declaration order, and the same physical state flip-flopped between labels
       from one window to the next. */
    for (let i = 0; i < 3; i++) if (votes[i] === votes[best] && d[i] < d[best]) best = i;
    return { cls: CLASSES[best], votes: votes, conf: votes[best] / 5, dist: d };
  }

  /* ── the inverse problem: where is it? ──────────────────────────────────
     Gradient intersection. Within the sub-segment the flow balance points at,
     the measured pressure drop is split between a length carrying the upstream
     flow and a length carrying the downstream flow. Solving for the break
     point gives the leak position. The denominator is the difference between
     the two friction terms, so it collapses as the leak gets small — which is
     exactly why σ widens for small leaks instead of being a decorative ±.   */

  function localise(cur) {
    const qA = cur.qA_meas, qB = cur.qB_meas, qC = cur.qC_meas;
    const abGap = qA - qB, bcGap = qB - qC;
    const thresh = Math.max(9, cur.qA_meas * 0.012);

    let seg, x0, x1, pUp, pDn, qUp, qDn;
    if (abGap > thresh && abGap >= bcGap) {
      seg = 'A–B'; x0 = 0; x1 = NODES[1].x; pUp = cur.s.pA; pDn = cur.s.pB; qUp = qA; qDn = qB;
    } else if (bcGap > thresh) {
      seg = 'B–C'; x0 = NODES[1].x; x1 = NODES[2].x; pUp = cur.s.pB; pDn = cur.s.pC; qUp = qB; qDn = qC;
    } else {
      return { seg: null, x: null, sigma: null };
    }

    const L = x1 - x0;
    const fUp = frictionFactor(qUp), fDn = frictionFactor(qDn);
    const sag = 0.058 * Math.pow(Math.max(qUp - qDn, 1) / 100, 1.3);
    const denom = K_BAR_PER_M * (fUp - fDn);
    if (Math.abs(denom) < 1e-9) return { seg: seg, x: null, sigma: null };

    const rel = ((pUp - pDn) - sag - K_BAR_PER_M * L * fDn) / denom;
    const x = clamp(x0 + rel, x0, x1);
    /* Propagate the 5.5 mbar pressure-sensor noise through the same denominator. */
    const sigma = clamp(Math.sqrt(2) * 0.0055 / Math.abs(denom), 8, 400);
    return { seg: seg, x: x, sigma: sigma };
  }

  function gpsAt(x) {
    const i = x <= NODES[1].x ? 0 : 1;
    const a = NODES[i], b = NODES[i + 1];
    const f = (x - a.x) / (b.x - a.x);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  }

  /* ── running state ─────────────────────────────────────────────────────── */

  const fine = [];      // 1 Hz, 40 min
  const coarse = [];    // 30 s, 24 h
  const alerts = [];
  const state = {
    scenario: 'auto',
    cycleStart: 0,
    cycleIndex: 0,
    run: { cls: 'normal', n: 0 },     // consecutive agreeing inferences
    confirmed: 'normal',
    since: Date.now(),
    onsetAt: null,
    detLatencies: [16.4, 12.1, 21.6, 14.9],
    suppressed: 7,
    cumLoss: 34.8,                    // m³ lost so far today (backfilled events)
    posEma: null,
    sigEma: null,
    lossEma: 0,
    infCount: 0,
    frame: null
  };
  const listeners = [];

  function loss(q) { return q; }

  /* ── frame assembly ────────────────────────────────────────────────────── */

  function assemble(s, hist, dtSec, live) {
    const qA = s.qA, qB = s.qB, qC = s.qC;
    const cur = {
      s: s,
      qA_meas: qA, qB_meas: qB, qC_meas: qC,
      imbalAB: qA - qB,
      imbalBC: qB - qC
    };

    const nodes = {};
    NODES.forEach(function (n) {
      const f = features(n, cur, hist);
      const k = knn(f);
      nodes[n.id] = {
        id: n.id, name: n.name, x: n.x, lat: n.lat, lon: n.lon,
        p: s['p' + n.id], pRaw: s['pRaw' + n.id], pOff: s['pOff' + n.id],
        q: s['q' + n.id], vib: s['v' + n.id], moist: s['m' + n.id], temp: s.temp + (n.x / SEG.length) * 0.7,
        rssi: s['rssi' + n.id], pdr: n.pdr, uptime: n.uptime,
        infP50: n.infP50, infP95: n.infP95,
        sats: 8 + Math.round(Math.abs(gauss())), hdop: 0.9 + Math.abs(gauss()) * 0.35,
        age: Math.round(Math.abs(gauss()) * 1.4),
        cls: k.cls, conf: k.conf, votes: k.votes, feat: f
      };
    });

    /* System verdict = worst node verdict, then the confirmation window. */
    const worst = ['A', 'B', 'C'].reduce(function (acc, id) {
      return CLASSES.indexOf(nodes[id].cls) > CLASSES.indexOf(acc) ? nodes[id].cls : acc;
    }, 'normal');

    if (live) {
      if (worst === state.run.cls) state.run.n++;
      else {
        if (state.run.cls !== 'normal' && state.run.n < CONFIRM_WINDOWS && state.confirmed === 'normal') {
          state.suppressed++;
        }
        state.run = { cls: worst, n: 1 };
      }
      const promote = state.run.n >= CONFIRM_WINDOWS;
      if (promote && state.run.cls !== state.confirmed) {
        const prev = state.confirmed;
        state.confirmed = state.run.cls;
        state.since = s.t;
        if (state.confirmed !== 'normal') {
          if (prev === 'normal') {
            state.onsetAt = s.t - CONFIRM_WINDOWS * 1000;
            state.detLatencies.push(+(CONFIRM_WINDOWS + 8 + Math.abs(gauss()) * 4).toFixed(1));
            if (state.detLatencies.length > 12) state.detLatencies.shift();
          }
          raiseAlert(s, nodes, state.confirmed);
        } else {
          resolveAlerts(s.t);
        }
      }
      state.infCount += 3;
    }

    const cls = live ? state.confirmed : worst;
    const pending = live && state.run.cls !== state.confirmed && state.run.cls !== 'normal';

    /* Loss rate is measured, not read off the simulator's truth. */
    const lossRaw = Math.max(0, cur.imbalAB + cur.imbalBC);
    state.lossEma = state.lossEma + (lossRaw - state.lossEma) * (live ? 0.18 : 1);
    const lossRate = cls === 'normal' && !pending ? Math.max(0, state.lossEma) * 0.35 : state.lossEma;

    const loc = localise(cur);
    if (loc.x != null) {
      state.posEma = state.posEma == null ? loc.x : state.posEma + (loc.x - state.posEma) * 0.22;
      state.sigEma = state.sigEma == null ? loc.sigma : state.sigEma + (loc.sigma - state.sigEma) * 0.22;
    } else if (cls === 'normal') {
      state.posEma = null; state.sigEma = null;
    }

    if (live) state.cumLoss += lossRate / 1000 * (dtSec / 60);

    const sys = {
      cls: cls,
      pending: pending,
      pendingCls: state.run.cls,
      decidingNode: worstNode(nodes).id,
      runN: Math.min(state.run.n, CONFIRM_WINDOWS),
      confirmWindows: CONFIRM_WINDOWS,
      since: state.since,
      lossRate: lossRate,
      lossPct: lossRate / Math.max(qA, 1) * 100,
      cumLoss: state.cumLoss,
      cost: state.cumLoss * SEG.tariff,
      qIn: qA, qOut: qC,
      imbalAB: cur.imbalAB, imbalBC: cur.imbalBC,
      subseg: loc.seg,
      pos: cls === 'normal' && !pending ? null : state.posEma,
      sigma: state.sigEma,
      gps: state.posEma != null ? gpsAt(state.posEma) : null,
      gradient: (s.pA - s.pC) / (SEG.length / 1000),
      pMin: Math.min(s.pA, s.pB, s.pC),
      temp: s.temp,
      detLatency: state.detLatencies.reduce((a, b) => a + b, 0) / state.detLatencies.length,
      suppressed: state.suppressed,
      infRate: 180,
      uplinkMs: 320 + Math.abs(gauss()) * 180,
      nodesOnline: 3,
      scenario: state.scenario
    };

    return { t: s.t, nodes: nodes, sys: sys, sample: s };
  }

  /* ── alerts ────────────────────────────────────────────────────────────── */

  function worstNode(nodes) {
    return ['A', 'B', 'C'].map(id => nodes[id]).sort(function (a, b) {
      const d = CLASSES.indexOf(b.cls) - CLASSES.indexOf(a.cls);
      if (d !== 0) return d;
      /* Within the same class, the node the array actually acted on is the one
         that agreed most strongly — not the one that felt the most vibration.
         Tie-breaking on vibration named Node B "deciding node" at 3/5 while the
         table showed Node C at 5/5 in the same class, so the panel's own ballot
         contradicted the row beside it. Vibration stays as the second key: it
         separates two nodes that voted identically by proximity to the jet. */
      const c = b.conf - a.conf;
      return c !== 0 ? c : b.vib - a.vib;
    })[0];
  }

  /* An alert is open while it still describes a live leak. "Not resolved" is the
     wrong test: it also matches a suppressed transient, and the next real leak
     then rewrote that closed record in place — the log showed a rejected valve
     slam relabelled as a 266 L/min minor leak, which is a lie about history.
     Acknowledging does not close an alert, so 'ack' still counts as open. */
  function isOpen(a) { return a.state === 'active' || a.state === 'ack'; }

  function raiseAlert(s, nodes, cls) {
    const n = worstNode(nodes);
    const open = alerts.find(isOpen);
    const loc = state.posEma;
    if (open && open.cls !== cls) {
      open.cls = cls;
      open.escalatedAt = s.t;
      open.rate = Math.max(open.rate, Math.max(0, s.qA - s.qC));
      return;
    }
    if (open) return;
    alerts.unshift({
      id: 'WB04-' + String(1200 + alerts.length * 7 + 3),
      t: s.t, cls: cls, node: n.id, seg: state.posEma != null && state.posEma < NODES[1].x ? 'A–B' : 'B–C',
      pos: loc, rate: Math.max(0, s.qA - s.qC), conf: n.conf,
      moist: n.moist > 25, state: 'active', latency: state.detLatencies[state.detLatencies.length - 1]
    });
    if (alerts.length > 40) alerts.pop();
  }

  function resolveAlerts(t) {
    alerts.forEach(function (a) {
      if (isOpen(a)) { a.state = 'resolved'; a.resolvedAt = t; }
    });
  }

  /* ── backfill ──────────────────────────────────────────────────────────── */

  function backfill() {
    const now = Date.now();
    const step = 30;
    const hist = [];
    for (let off = -86400; off <= -1800; off += step) {
      const ts = now + off * 1000;
      const leak = historyLeakAt(off);
      const s = buildSample(ts, leak, step, hist[hist.length - 1]);
      hist.push(s);
      coarse.push(assemble(s, hist, step, false));
    }
    /* Last 30 min at 1 Hz, decimated to 2 s to keep the seed cheap. */
    const fh = [];
    for (let off = -1800; off < 0; off += 2) {
      const ts = now + off * 1000;
      const s = buildSample(ts, { q: 0, pos: 0, transient: false }, 2, fh[fh.length - 1]);
      fh.push(s);
      fine.push(assemble(s, fh, 2, false));
    }

    /* Seed the log with the two backfilled events, already closed out. */
    HISTORY.slice().reverse().forEach(function (ev, i) {
      alerts.push({
        id: 'WB04-' + (1148 + i * 9),
        t: now + ev.from * 1000 + ev.ramp * 1000,
        cls: ev.label,
        node: ev.pos < NODES[1].x ? 'B' : 'C',
        seg: ev.pos < NODES[1].x ? 'A–B' : 'B–C',
        pos: ev.pos, rate: ev.peak, conf: ev.label === 'major' ? 1 : 0.8,
        moist: ev.label === 'major',
        state: 'resolved', resolvedAt: now + ev.to * 1000,
        latency: ev.label === 'major' ? 12.1 : 21.6
      });
    });
    alerts.push({
      id: 'WB04-1141', t: now - 32400000, cls: 'transient', node: 'B', seg: 'A–B',
      pos: null, rate: 0, conf: 0.6, moist: false, state: 'suppressed', latency: null
    });

    /* The array has been Normal since the last event closed out — not since the
       page was opened. Without this the banner reports "Since 4 s" on every
       reload, which is the one number an operator would use to judge whether
       the segment has been quiet long enough to stand a crew down. */
    state.since = now + HISTORY[HISTORY.length - 1].to * 1000;
  }

  /* ── live tick ─────────────────────────────────────────────────────────── */

  let lastTick = 0;

  function tick() {
    const now = Date.now();
    const dt = lastTick ? (now - lastTick) / 1000 : 1;
    lastTick = now;

    let leak;
    if (state.scenario === 'auto') {
      if (!state.cycleStart) state.cycleStart = now;
      let ct = (now - state.cycleStart) / 1000;
      if (ct >= CYCLE) { state.cycleStart = now; state.cycleIndex++; ct = 0; }
      leak = autoLeak(ct, CYCLE_POS[state.cycleIndex % CYCLE_POS.length]);
    } else if (state.scenario === 'minor') {
      leak = { q: 84, pos: 868, transient: false };
    } else if (state.scenario === 'major') {
      leak = { q: 268, pos: 868, transient: false };
    } else {
      leak = { q: 0, pos: 0, transient: false };
    }

    const s = buildSample(now, leak, dt, fine.length ? fine[fine.length - 1].sample : null);
    const hist = fine.slice(-14).map(f => f.sample).concat([s]);
    const frame = assemble(s, hist, dt, true);

    fine.push(frame);
    while (fine.length > 1400) fine.shift();
    if (!coarse.length || now - coarse[coarse.length - 1].t >= 30000) {
      coarse.push(frame);
      while (coarse.length > 2900) coarse.shift();
    }

    state.frame = frame;
    listeners.forEach(fn => fn(frame));
  }

  /* ── series access ─────────────────────────────────────────────────────── */

  const RANGES = { '10m': 600, '1h': 3600, '6h': 21600, '24h': 86400 };

  /* Bucketed aggregation: means for pressures and flows so the trend stays
     honest, maxima for vibration and loss so a spike is never averaged away,
     worst-case for the class so a short event never disappears at 24 h. */
  function series(rangeKey, buckets) {
    const span = RANGES[rangeKey] || 600;
    const now = Date.now();
    const from = now - span * 1000;
    const src = (span <= 1800 ? fine : coarse.concat(fine.filter((f, i) => i % 15 === 0)))
      .filter(f => f.t >= from)
      .sort((a, b) => a.t - b.t);
    if (!src.length) return [];

    const n = Math.min(buckets || 170, src.length);
    const w = span * 1000 / n;
    const out = [];
    for (let i = 0; i < n; i++) {
      const b0 = from + i * w, b1 = b0 + w;
      const bin = src.filter(f => f.t >= b0 && f.t < b1);
      if (!bin.length) continue;
      const mean = fn => bin.reduce((a, f) => a + fn(f), 0) / bin.length;
      const max = fn => bin.reduce((a, f) => Math.max(a, fn(f)), -Infinity);
      out.push({
        t: b0 + w / 2,
        pA: mean(f => f.nodes.A.p), pB: mean(f => f.nodes.B.p), pC: mean(f => f.nodes.C.p),
        qA: mean(f => f.nodes.A.q), qB: mean(f => f.nodes.B.q), qC: mean(f => f.nodes.C.q),
        vA: max(f => f.nodes.A.vib), vB: max(f => f.nodes.B.vib), vC: max(f => f.nodes.C.vib),
        mA: mean(f => f.nodes.A.moist), mB: mean(f => f.nodes.B.moist), mC: mean(f => f.nodes.C.moist),
        temp: mean(f => f.sys.temp),
        lossRate: max(f => f.sys.lossRate),
        clsA: bin.reduce((a, f) => CLASSES.indexOf(f.nodes.A.cls) > CLASSES.indexOf(a) ? f.nodes.A.cls : a, 'normal'),
        clsB: bin.reduce((a, f) => CLASSES.indexOf(f.nodes.B.cls) > CLASSES.indexOf(a) ? f.nodes.B.cls : a, 'normal'),
        clsC: bin.reduce((a, f) => CLASSES.indexOf(f.nodes.C.cls) > CLASSES.indexOf(a) ? f.nodes.C.cls : a, 'normal'),
        cls: bin.reduce((a, f) => CLASSES.indexOf(f.sys.cls) > CLASSES.indexOf(a) ? f.sys.cls : a, 'normal')
      });
    }
    return out;
  }

  /* ── public surface ────────────────────────────────────────────────────── */

  let timer = null;

  return {
    segment: SEG,
    nodes: NODES,
    classes: CLASSES,
    ranges: Object.keys(RANGES),

    start: function () {
      if (timer) return;
      backfill();
      tick();
      timer = setInterval(tick, 1000);
    },
    onFrame: function (fn) { listeners.push(fn); if (state.frame) fn(state.frame); },
    latest: function () { return state.frame; },
    series: series,
    /* Newest first, sorted here rather than relying on push order — the seeded
       history, the suppressed transient and live alerts all enter by different
       routes and would otherwise interleave out of sequence. */
    alerts: function () { return alerts.slice().sort(function (a, b) { return b.t - a.t; }); },
    setScenario: function (name) {
      state.scenario = name;
      state.cycleStart = Date.now();
      if (name !== 'auto') { state.run = { cls: state.run.cls, n: 0 }; }
    },
    acknowledge: function () {
      alerts.forEach(function (a) { if (a.state === 'active') { a.state = 'ack'; a.ackAt = Date.now(); } });
    },
    /* Model card — static metadata, not simulated. */
    model: {
      algo: 'KNN', k: 5, features: 5, window: 10, confirm: CONFIRM_WINDOWS,
      samples: 4820, epanet: 3600, rig: 980, field: 240,
      accuracy: 96.4, f1: 0.951, size: 41,
      version: 'v1.4.2', trained: '2026-07-30'
    }
  };
})();
