/* ============================================================================
   verify-simulator.js — headless checks on js/telemetry.js

     node tools/verify-simulator.js

   The dashboard's credibility rests on the simulator classifying the scenarios
   it claims to. That is cheap to assert and expensive to eyeball, so it is
   asserted here rather than in a browser. Every check below exists because it
   caught something:

     · a major burst classified as a *minor* leak, because the pressure
       deficit feature referenced the inlet meter — which rises with the leak,
       cancelling the very sag it was meant to measure;
     · a rejected valve-slam transient in the event log being rewritten in place
       by the next real leak, because "not resolved" also matches "suppressed";
     · an acknowledged alert that could never close, once that test was narrowed;
     · the classifier panel captioning a different node than the alert it was
       explaining, because the render layer kept its own copy of the rule.

   Exits non-zero on the first failed assertion.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

/* ── load telemetry.js, which is a browser script, not a module ──────────── */

const root = path.join(__dirname, '..');
global.window = global;

let intervals = [];
global.setInterval = function (fn) { intervals.push(fn); return intervals.length; };
global.clearInterval = function () {};

/* A virtual clock advanced one second per tick. Without it Date.now() barely
   moves inside a synchronous loop: every sample in the 10 s window shares a
   timestamp, the dP/dt denominator floors, and the run reports ±1 bar/min of
   noise on a pipe that is flat. The browser ticks on a real 1 Hz interval and
   never sees this, so the harness has to reproduce the cadence. */
let clock = Date.parse('2026-01-06T09:00:00+01:00');
Date.now = function () { return clock; };

const src = fs.readFileSync(path.join(root, 'js/telemetry.js'), 'utf8');
const Telemetry = new Function(
  '(function(){' + src + '\nreturn Telemetry;})()'
).call(null) || new Function('return (function(){' + src + '\nreturn Telemetry;})()')();

function tick(seconds) {
  for (let i = 0; i < seconds; i++) { clock += 1000; intervals.forEach(fn => fn()); }
  return Telemetry.latest();
}

/* ── assertions ─────────────────────────────────────────────────────────── */

let failures = 0;

function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
}

function scenario(name, seconds) {
  Telemetry.setScenario(name);
  return tick(seconds);
}

Telemetry.start();

console.log('\nscenario classification');

['normal', 'minor', 'major'].forEach(function (name) {
  const f = scenario(name, 90);
  const decide = f.nodes[f.sys.decidingNode];
  const detail = 'loss=' + Math.round(f.sys.lossRate) + ' L/min' +
    '  deciding=' + f.sys.decidingNode + ' ' + decide.votes.join('/') +
    '  devP=' + (decide.feat[0] * 100).toFixed(1) + '%' +
    '  dP/dt=' + decide.feat[1].toFixed(3) + ' bar/min' +
    '  vib=' + Math.round(decide.feat[2]) + ' mg' +
    '  imbal=' + decide.feat[3].toFixed(1) + '%';
  check('"' + name + '" confirms as ' + name, f.sys.cls === name, detail);

  /* The deciding node must be one the operator can corroborate from the node
     table, so its class has to match the array's. */
  check('  deciding node agrees with the array', decide.cls === f.sys.cls,
    'node ' + f.sys.decidingNode + ' reads ' + decide.cls);

  /* Node A is the inlet, upstream of both scenario leak positions: it sees the
     extra throughput but no deficit, so it must stay normal. A leak that lights
     up all three nodes equally would mean localisation had nothing to work with. */
  if (name !== 'normal') {
    check('  inlet node stays normal (leak is downstream of it)',
      f.nodes.A.cls === 'normal', 'A reads ' + f.nodes.A.cls);
    check('  localisation lands inside the segment',
      f.sys.pos > 0 && f.sys.pos < Telemetry.segment.length,
      'pos=' + Math.round(f.sys.pos) + ' m ±' + Math.round(f.sys.sigma));
  }
});

console.log('\nhardware-model alignment');

const rig = scenario('minor', 30);
check('minor test stays near Q1=10.00, Q2=9.00, Q3=8.95 L/min',
  Math.abs(rig.nodes.A.q - 10.00) < 0.04 &&
  Math.abs(rig.nodes.B.q - 9.00) < 0.04 &&
  Math.abs(rig.nodes.C.q - 8.95) < 0.04,
  [rig.nodes.A.q, rig.nodes.B.q, rig.nodes.C.q].map(v => v.toFixed(2)).join('/'));
check('minor test reports segment 1 near 10% and segment 2 near 0.56%',
  Math.abs(rig.sys.lossABPct - 10) < 0.5 && Math.abs(rig.sys.lossBCPct - 0.56) < 0.15,
  rig.sys.lossABPct.toFixed(2) + '% / ' + rig.sys.lossBCPct.toFixed(2) + '%');

const review = scenario('review', 10);
check('out-of-range inlet is held for review, not classified as a leak',
  review.sys.dataQuality === 'REVIEW_REQUIRED' &&
  review.sys.reviewReason === 'INLET_OUTSIDE_TRAINING_RANGE' &&
  review.sys.cls === 'normal',
  'Q=' + [review.nodes.A.q, review.nodes.B.q, review.nodes.C.q].map(v => v.toFixed(2)).join('/') +
  ' quality=' + review.sys.dataQuality);

console.log('\nalert lifecycle');

const suppressed = Telemetry.alerts().find(a => a.state === 'suppressed');
scenario('major', 60);
const same = Telemetry.alerts().find(a => a.id === (suppressed || {}).id);
check('a suppressed transient survives a later leak unaltered',
  !!same && same.cls === 'transient' && same.rate === 0 && same.state === 'suppressed',
  same ? same.id + ' cls=' + same.cls + ' rate=' + same.rate + ' state=' + same.state : 'record lost');

const open = () => Telemetry.alerts().filter(a => a.state === 'active' || a.state === 'ack');
check('one open alert per leak, not one per window', open().length === 1,
  open().length + ' open');

Telemetry.acknowledge();
check('acknowledging does not close the alert', open().length === 1);

scenario('normal', 60);
check('an acknowledged alert still closes once repaired', open().length === 0,
  Telemetry.alerts().slice(0, 3).map(a => a.state).join(', '));

console.log('\nauto cycle (the default view)');

const before = Telemetry.latest().sys.suppressed;
Telemetry.setScenario('auto');
const seen = {};
let peak = 0;
for (let i = 0; i < 900; i++) {
  const f = tick(1);
  seen[f.sys.cls] = (seen[f.sys.cls] || 0) + 1;
  peak = Math.max(peak, f.sys.lossRate);
}
check('reaches all three states within 15 min',
  seen.normal > 0 && seen.minor > 0 && seen.major > 0, JSON.stringify(seen));
check('rejects transients without alerting',
  Telemetry.latest().sys.suppressed > before,
  (Telemetry.latest().sys.suppressed - before) + ' rejected, peak loss ' + Math.round(peak) + ' L/min');

console.log(failures ? '\n' + failures + ' check(s) failed\n' : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
