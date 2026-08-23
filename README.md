# Pipeline Integrity Monitor — Segment WB-04

An operator console for the IoT edge-AI water-pipeline leak-detection system
described in `Pipeline_Leak_Detection_Overview (1).docx`: three ESP32 nodes on a
1,240 m DN150 trunk main, each running a k=5 KNN classifier on-device and
reporting to the cloud at 1 Hz.

Open `index.html`. No build step, no dependencies, no network calls.

```
index.html                 structure and the DOM contract the render layer binds to
css/dashboard.css          tokens and layout; light and dark are both authored
js/telemetry.js            THE SIMULATOR — the only file that invents data
js/charts.js               hand-rolled SVG: line, columns, ribbon, spark, schematic
js/dashboard.js            pure render layer; holds no domain logic
tools/verify-simulator.js  node tools/verify-simulator.js — asserts the scenarios
```

---

## The database is not attached yet

There is no Firebase or ThingSpeak connection. Every number on the page comes
from `js/telemetry.js`, and the page says so — the filter bar carries a
**Simulated feed** chip and the footer names the file.

What that module is *not* is a random-number generator wearing a telemetry
costume. It runs a small hydraulic model of the segment and derives every
reading from it, so the panels agree with each other the way real instruments
do. When a leak opens at 868 m:

- inlet flow rises and outlet flow does not, so the imbalance appears between
  the two meters that bracket the leak, and **that** is what localises it;
- Hazen-Williams headloss (C=110) rises on the upstream length only, so Node A
  holds while B and C sag, and the hydraulic grade line develops a visible knee;
- jet noise peaks at the orifice and decays as `exp(-d/210)`, so vibration
  ranks B above C above A by distance, not by chance;
- joint moisture only rises if an instrumented joint lies within 90 m — usually
  none does, and the banner says so rather than implying a confirmation it does
  not have.

Because the readings share one model, an operator cross-checking two panels
finds them consistent. That is the property that would break first if the
numbers were faked independently, and it is the reason the swap below is small.

### Determinism

The noise comes from a seeded `mulberry32` PRNG, so equal elapsed time yields
equal noise. Two reloads at the same age show the same ΔQ — that is the seed,
not a per-meter bias.

---

## Swapping in the real feed

`js/dashboard.js` never touches the hydraulic model; it only consumes frames.
Replace the body of `js/telemetry.js` with a reader that emits the same shape and
nothing else has to change.

Keep this public surface:

| Member | Contract |
|---|---|
| `start()` | begin polling; backfill history, then emit at 1 Hz |
| `onFrame(fn)` | subscribe; called immediately with the current frame if one exists |
| `latest()` | most recent frame |
| `series(rangeKey, buckets)` | bucketed history for `'10m' \| '1h' \| '6h' \| '24h'` |
| `alerts()` | alert records, newest first |
| `segment`, `nodes`, `classes`, `ranges`, `model` | static metadata |
| `setScenario(name)`, `acknowledge()` | `setScenario` is a demo affordance — drop it, and remove the Scenario picker from `index.html`, once real data arrives |

### The frame

```js
{
  t: 1767686400000,                 // ms epoch
  sample: { … },                    // raw sensor read, before feature building
  nodes: {
    A: {
      id, name, x,                  // x = metres from the inlet
      lat, lon,                     // NEO-6M fix, used for the leak's GPS
      p, pRaw, pOff,                // bar: corrected, raw, thermal offset
      q, vib, moist, temp,          // L/min, mg RMS, %, °C
      rssi, pdr, uptime, age,       // link health; age = packet age in seconds
      sats, hdop, infP50, infP95,   // GPS quality, inference latency in ms
      cls, conf, votes, feat        // 'normal'|'minor'|'major', k-vote split, 5 features
    },
    B: { … }, C: { … }
  },
  sys: {
    cls, pending, pendingCls,       // confirmed class; pending = a run not yet 4 windows old
    runN, confirmWindows,           // progress toward confirmation
    decidingNode: 'B',              // the node the array acted on — see note below
    since,                          // ms epoch the current state began
    lossRate, lossPct,              // L/min, % of inlet
    cumLoss, cost,                  // m³ today, ₦ at the bulk tariff
    qIn, qOut, imbalAB, imbalBC,    // L/min
    pos, sigma, subseg, gps,        // localisation: m from inlet, ±1σ, 'A–B'|'B–C', {lat,lon}
    gradient, pMin, temp,           // bar/km, bar, °C
    detLatency, suppressed,         // mean seconds to detect; transients rejected today
    infRate, uplinkMs, nodesOnline, scenario
  }
}
```

`series()` returns buckets of
`{ t, pA pB pC, qA qB qC, vA vB vC, mA mB mC, temp, lossRate, clsA clsB clsC, cls }`.
Pressures, flows and moisture are bucket **means** so a trend stays honest;
vibration and loss rate are **maxima** so a spike is never averaged away; classes
are **worst-case** so a short event does not vanish at the 24 h range.

An alert record is
`{ id, t, cls, node, seg, pos, rate, conf, moist, state, latency }`
plus `escalatedAt` / `ackAt` / `resolvedAt` as they occur, where `state` is one of
`active` · `ack` · `resolved` · `suppressed`. **`suppressed` is terminal** — it
records a transient the confirmation rule rejected, and nothing may later rewrite
it as a leak.

---

## The classifier

KNN, k=5, five engineered features over a 10 s window:

```
[ pressure deficit vs model,  dP/dt,  vibration RMS,  local flow imbalance,  joint moisture ]
```

Five neighbour votes are apportioned by largest remainder, and confidence is the
winning share of those five — the panel shows the split, never an invented
percentage. **Four consecutive agreeing windows** are required before an alert
is raised, which is what makes a valve slam a rejected transient instead of a
callout.

Two calibration points are worth knowing before touching `CENTROIDS`:

- **Centroids are set to what this array can observe, not to what a leak
  emits.** The jet reaches ~112 mg at the orifice, but with three nodes over
  1,240 m the nearest is usually 200–400 m away and reads ~52 mg. A centroid at
  the emitted figure is unreachable, and an unreachable centroid silently
  downgrades every real leak toward the class below it.
- **Moisture confirms; it must never veto.** Three instrumented joints over
  1,240 m means most leak positions wet nothing, so moisture's scale is
  deliberately loose. Tightening it makes a dry major leak classify as minor.

Ties go to the nearer centroid, never to declaration order — array order
favoured the *less* severe class, which is the wrong default for a leak.

The **deciding node** is chosen in `telemetry.js` and published on the frame, so
the classifier panel and the alert record always name the same node. Do not
recompute it in the render layer; that copy drifted once already.

`tools/verify-simulator.js` asserts all of this without a browser. Run it after
any change to the model.

---

## Reading the page

The banner states the confirmed class, the estimated loss rate, and where the
leak is. Everything below it is the evidence for that claim, in the order an
operator would want it: the grade line and the flow balance that located it, the
vibration ranking that corroborates it, the classification history that shows how
long each node has been in its state, and the raw node table underneath.

- **Non-revenue water** is loss as a percentage of inlet throughput; the cost
  line uses the ₦285/m³ bulk tariff named in the footer.
- **Localisation** is a gradient intersection within the sub-segment the flow
  balance points at, reported at ±1σ from the flow-balance residual. A minor
  leak carries a wider band than a major one because the gradient signal it
  leaves is weaker — that is honest, not a defect.
- **Thermal compensation** shows the BMP280 drift (4.2 mbar/°C above a 25 °C
  calibration) being subtracted before the feature vector is built. The raw,
  drift and corrected columns reconcile at the precision displayed.
- Every plotted chart has a **Table** toggle; the thermal, node and event panels
  are tables already. Status is never carried by colour alone; both themes are
  authored rather than flipped, and the page follows the operating system until
  the theme toggle is used.

Figures in the model card — 4,820 labelled samples, 96.4 % hold-out accuracy,
41 KB quantised — are the project's own, carried from the brief. They are
metadata, not simulated, and should be updated from the real training run.
