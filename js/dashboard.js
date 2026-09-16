/* ============================================================================
   dashboard.js — render layer
   ----------------------------------------------------------------------------
   Consumes frames from Telemetry and paints them. It holds no domain logic and
   no data of its own: swapping the simulator for the live Firebase/ThingSpeak
   reader changes nothing in this file.
   ========================================================================== */

(function () {
  'use strict';

  /* ── state → status token ──────────────────────────────────────────────
     Three classifier outputs plus one operational state. Status colours are
     reserved for exactly this; they are never reused as a series colour, and
     they always ship with an icon and a label so hue never carries meaning
     on its own.                                                            */

  const STATE = {
    normal:  { key: 'good',    name: 'Flow is normal', icon: '#i-good', color: 'var(--good)',    ink: 'var(--good-ink)' },
    watch:   { key: 'warn',    name: 'Checking a change', icon: '#i-warn', color: 'var(--warn)',    ink: 'var(--warn-ink)' },
    minor:   { key: 'serious', name: 'Minor leak',  icon: '#i-warn', color: 'var(--serious)', ink: 'var(--serious-ink)' },
    major:   { key: 'crit',    name: 'Major leak',  icon: '#i-crit', color: 'var(--crit)',    ink: 'var(--crit-ink)' }
  };

  const NODE_COLOR = { A: 'var(--s1)', B: 'var(--s2)', C: 'var(--s3)' };
  const NODE_LIST = ['A', 'B', 'C'];

  /* ── formatting ────────────────────────────────────────────────────────── */

  const f0 = v => isFinite(v) ? Math.round(v).toLocaleString('en-GB') : '—';
  const f1 = v => isFinite(v) ? v.toFixed(1) : '—';
  const f2 = v => isFinite(v) ? v.toFixed(2) : '—';
  const pct = v => isFinite(v) ? v.toFixed(1) + ' %' : '—';
  const naira = v => '₦' + Math.round(v).toLocaleString('en-GB');
  const gps = g => g ? g.lat.toFixed(5) + ' N, ' + g.lon.toFixed(5) + ' E' : '—';

  function dur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' m ' + String(s % 60).padStart(2, '0') + ' s';
    const h = Math.floor(m / 60);
    return h + ' h ' + String(m % 60).padStart(2, '0') + ' m';
  }
  const clockOf = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Lagos' });
  const hhmm = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
  /* The log covers 24 h, so roughly half of every night shift's entries fall on
     the previous calendar day. Date only where it differs from today — a date on
     every row would bury the one that matters. */
  const dayOf = t => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' });
  const dayHint = t => dayOf(t) === dayOf(Date.now())
    ? null
    : new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Africa/Lagos' });

  /* ── small DOM helpers ─────────────────────────────────────────────────── */

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function icon(href, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', cls || 'ico');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', href);
    s.appendChild(u);
    return s;
  }
  function tag(state, label) {
    const t = h('span', 'tag');
    t.dataset.state = state.key !== undefined ? state.key : state;
    t.append(icon(state.icon || '#i-good', 'ico'), h('span', null, label));
    return t;
  }
  function badge(id) {
    const b = h('span', 'node-badge', id);
    b.dataset.node = id;
    return b;
  }

  /* ── view state ────────────────────────────────────────────────────────── */

  const view = {
    range: '10m',
    nodes: { A: true, B: true, C: true },
    tables: {},
    motion: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    hoverLock: false,
    lastChartPaint: 0
  };

  const activeNodes = () => NODE_LIST.filter(id => view.nodes[id]);

  /* ── theme ─────────────────────────────────────────────────────────────── */

  function readStored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeStored(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function applyTheme(mode, persist) {
    document.documentElement.setAttribute('data-theme', mode);
    document.getElementById('theme-icon').setAttribute('href', mode === 'dark' ? '#i-sun' : '#i-moon');
    /* Only an explicit toggle is remembered. Persisting the resolved boot mode
       too would freeze the first-ever OS reading in place forever. */
    if (persist) writeStored('pim-theme', mode);
    paintCharts(true);
  }

  document.getElementById('theme-toggle').addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
  });

  /* ── legends ───────────────────────────────────────────────────────────── */

  function nodeLegend(host, mark) {
    host.replaceChildren();
    NODE_LIST.forEach(function (id) {
      if (!view.nodes[id]) return;
      const n = Telemetry.nodes.find(x => x.id === id);
      const lg = h('span', 'lg');
      const b = h('i', 'badge', id);
      b.style.background = NODE_COLOR[id];
      const k = h('i', mark === 'rect' ? 'rk' : 'lk');
      k.style.background = NODE_COLOR[id];
      lg.append(b, h('span', null, n.name));
      host.appendChild(lg);
    });
  }

  /* Per-node KNN output is one of three classes. "Under review" is a *system*
     state produced by the confirmation rule, never a lane colour, so listing it
     here would promise a fourth colour the ribbon can never draw. */
  function classLegend(host) {
    host.replaceChildren();
    ['normal', 'minor', 'major'].forEach(function (k) {
      const s = STATE[k];
      const lg = h('span', 'lg');
      lg.append(icon(s.icon, 'ico'));
      lg.firstChild.style.color = s.ink;
      lg.append(h('span', null, s.name));
      host.appendChild(lg);
    });
  }

  /* ── KPI tiles ─────────────────────────────────────────────────────────── */

  const TILES = [
    {
      id: 'kpi-throughput', label: 'Water entering', icon: '#i-gauge', unit: 'L/min',
      value: f => f0(f.sys.qIn), spark: s => s.map(d => d.qA), color: 'var(--s1)',
      delta: function (f, s) {
        if (s.length < 8) return null;
        const then = s[0].qA, now = s[s.length - 1].qA;
        return { text: (now >= then ? '+' : '') + f1(now - then) + ' L/min in this window', dir: 'flat' };
      }
    },
    {
      id: 'kpi-nrw', label: 'Water escaping', icon: '#i-drop', unit: '% of inlet',
      value: f => f1(f.sys.lossPct), spark: s => s.map(d => d.lossRate), color: 'var(--crit)',
      delta: f => ({ text: f0(f.sys.lossRate) + ' L/min escaping', dir: f.sys.lossPct > 2 ? 'bad' : 'good' })
    },
    {
      id: 'kpi-pressure', label: 'Lowest pressure', icon: '#i-gauge', unit: 'bar',
      value: f => f2(f.sys.pMin), spark: s => s.map(d => Math.min(d.pA, d.pB, d.pC)), color: 'var(--s1)',
      delta: f => ({ text: f2(f.sys.gradient) + ' bar/km across the pipe', dir: f.sys.pMin < 1.6 ? 'bad' : 'flat' })
    },
    {
      id: 'kpi-lost', label: 'Water lost today', icon: '#i-drop', unit: 'm³',
      value: f => f1(f.sys.cumLoss),
      /* A cumulative figure gets a cumulative spark. Plotting the instantaneous
         rate here made the tile's headline number and its own trendline disagree
         about direction: the volume only ever rises, the rate wanders. */
      spark: function (s) {
        let acc = 0;
        return s.map(function (d, i) {
          const dtMin = i ? (d.t - s[i - 1].t) / 60000 : 0;
          acc += d.lossRate / 1000 * dtMin;
          return acc;
        });
      },
      color: 'var(--crit)',
      delta: f => ({ text: 'Estimated cost ' + naira(f.sys.cost), dir: 'flat' })
    },
    {
      id: 'kpi-latency', label: 'Time to detect', icon: '#i-clock', unit: 's',
      value: f => f1(f.sys.detLatency), spark: null,
      delta: f => ({ text: f.sys.suppressed + ' brief changes ignored', dir: 'good' })
    },
    {
      id: 'kpi-uptime', label: 'Sensor availability', icon: '#i-wifi', unit: '%',
      value: () => f1(Telemetry.nodes.reduce((a, n) => a + n.uptime, 0) / 3), spark: null,
      delta: f => ({ text: f.sys.nodesOnline + '/3 nodes available', dir: 'good' })
    }
  ];

  function paintTiles(frame, s) {
    TILES.forEach(function (spec) {
      const host = document.getElementById(spec.id);
      if (!host) return;
      host.replaceChildren();

      const head = h('div', 'tile-head');
      head.append(icon(spec.icon), h('span', 'micro', spec.label));
      host.appendChild(head);

      const val = h('div', 'tile-val');
      val.append(h('b', null, spec.value(frame)), h('span', null, spec.unit));
      host.appendChild(val);

      const foot = h('div', 'tile-foot');
      const d = spec.delta ? spec.delta(frame, s) : null;
      const dEl = h('span', 'delta', d ? d.text : '');
      if (d && d.dir !== 'flat') dEl.dataset.dir = d.dir;
      foot.appendChild(dEl);
      if (spec.spark && s.length > 3) {
        foot.appendChild(Charts.spark(spec.spark(s), { w: 80, h: 24, accent: spec.color }));
      }
      host.appendChild(foot);
    });
  }

  /* ── status banner ─────────────────────────────────────────────────────── */

  function sentence(frame) {
    const sys = frame.sys;
    const st = sys.pending ? STATE.watch : STATE[sys.cls];
    const parts = [];
    const push = (t, bold) => parts.push(bold ? { b: t } : t);

    if (sys.cls === 'normal' && !sys.pending) {
      push('Water is moving normally through the pipeline. All three sensors agree, and the amount entering matches the amount leaving.');
    } else if (sys.pending) {
      push('The sensors noticed a change. Checking whether it lasts: ');
      push(sys.runN + ' of ' + sys.confirmWindows + ' readings', 1);
      push(' agree so far. A brief disturbance will be ignored.');
    } else {
      const worst = NODE_LIST.map(id => frame.nodes[id]).sort((a, b) => b.vib - a.vib)[0];
      push('A leak is confirmed between sensors ');
      push(sys.subseg || '—', 1);
      push('. About ');
      push(f0(sys.lossRate) + ' litres per minute', 1);
      push(' may be escaping. The flow and pressure readings point to this area');
      push(worst.moist > 25 ? ', and a nearby moisture sensor also detected water.' : '.');
    }
    return { st: st, parts: parts };
  }

  function paintBanner(frame) {
    const sys = frame.sys;
    const { st, parts } = sentence(frame);
    const banner = document.getElementById('banner');
    banner.dataset.state = st.key;

    document.getElementById('state-icon').setAttribute('href', st.icon);
    document.getElementById('state-label').textContent = st.name;

    const line = document.getElementById('banner-line');
    line.replaceChildren();
    parts.forEach(function (p) {
      if (typeof p === 'string') line.appendChild(document.createTextNode(p));
      else line.appendChild(h('b', null, p.b));
    });

    document.getElementById('banner-vote').textContent = sys.pending
      ? sys.runN + '/' + sys.confirmWindows + ' windows'
      : sys.confirmWindows + '/' + sys.confirmWindows + ' windows';
    document.getElementById('banner-since').textContent = dur(Date.now() - sys.since);
    document.getElementById('banner-latency').textContent = f1(sys.detLatency) + ' s mean';

    document.getElementById('hero-loss').textContent = f0(sys.lossRate);
    document.getElementById('hero-sub').textContent =
      pct(sys.lossPct) + ' of water entering now · ' + f1(sys.cumLoss) +
      (sys.cls === 'normal' && !sys.pending ? ' m³ estimated lost earlier today' : ' m³ estimated lost so far today') +
      ' · ' + naira(sys.cost) + ' estimated cost';

    document.getElementById('loc-offset').textContent = sys.pos != null ? f0(sys.pos) + ' m ±' + f0(sys.sigma) : 'No leak located';
    document.getElementById('loc-seg').textContent = sys.subseg || 'None';
    document.getElementById('loc-gps').textContent = sys.pos != null ? gps(sys.gps) : 'Location appears when a leak is detected';

    const active = Telemetry.alerts().some(a => a.state === 'active');
    const ack = document.getElementById('ack-btn');
    ack.disabled = !active;
    ack.dataset.armed = active ? '1' : '0';
    ack.textContent = active ? 'Acknowledge alert' : Telemetry.alerts().some(a => a.state === 'ack') ? 'Acknowledged' : 'Acknowledge';

    /* masthead uplink pill */
    const beacon = document.querySelector('#link-state .beacon');
    beacon.dataset.state = sys.nodesOnline === 3 ? 'good' : 'warn';
    document.getElementById('link-detail').textContent = sys.nodesOnline + '/3 nodes available';
  }

  /* ── edge classifier panel ─────────────────────────────────────────────── */

  const FEATURES = [
    { name: 'Pressure deficit vs model', icon: '#i-gauge', fmt: v => (v * 100).toFixed(2), unit: '%' },
    { name: 'Pressure rate of change',   icon: '#i-gauge', fmt: v => v.toFixed(3),         unit: 'bar/min' },
    { name: 'Vibration RMS (10 s)',      icon: '#i-wave',  fmt: v => v.toFixed(1),         unit: 'mg' },
    { name: 'Local flow imbalance',      icon: '#i-drop',  fmt: v => v.toFixed(2),         unit: '%' },
    { name: 'Joint moisture',            icon: '#i-drop',  fmt: v => v.toFixed(1),         unit: '%' }
  ];

  function paintAI(frame) {
    const body = document.getElementById('ai-body');
    body.replaceChildren();

    /* The deciding node is chosen inside Telemetry, because the alert record and
       this panel must name the same node — a copy of the rule here drifted from
       the one in telemetry.js and the panel captioned a different node than the
       alert it was explaining. */
    const deciding = frame.nodes[frame.sys.decidingNode];

    const hd = h('div', 'tile-head');
    hd.append(badge(deciding.id), h('span', 'micro', 'Deciding node · ' + deciding.name));
    hd.style.marginBottom = '11px';
    body.appendChild(hd);

    const wrap = h('div', 'ai-class');
    Telemetry.classes.forEach(function (cls, i) {
      const row = h('div', 'ai-row');
      row.appendChild(h('span', 'lbl', STATE[cls].name));
      const m = h('div', 'meter');
      m.dataset.state = STATE[cls].key;
      const fill = h('i');
      fill.style.width = (deciding.votes[i] / 5 * 100) + '%';
      m.appendChild(fill);
      row.appendChild(m);
      row.appendChild(h('span', 'val', deciding.votes[i] + '/5'));
      wrap.appendChild(row);
    });
    body.appendChild(wrap);

    const vh = h('div');
    vh.style.marginTop = '12px';
    vh.appendChild(h('span', 'micro', 'Nearest-neighbour ballot · k = 5'));
    const votes = h('div', 'votes');
    votes.style.marginTop = '6px';
    Telemetry.classes.forEach(function (cls, ci) {
      for (let n = 0; n < deciding.votes[ci]; n++) {
        const v = h('div', 'vote', STATE[cls].name.charAt(0));
        v.dataset.state = STATE[cls].key;
        votes.appendChild(v);
      }
    });
    vh.appendChild(votes);
    body.appendChild(vh);

    body.appendChild(h('div', 'rule'));
    body.appendChild(h('span', 'micro', 'Feature vector · 10 s window'));
    const feat = h('div', 'feat');
    feat.style.marginTop = '7px';
    FEATURES.forEach(function (spec, i) {
      const nm = h('div', 'fname');
      nm.append(icon(spec.icon), h('span', null, spec.name));
      const vl = h('div', 'fval');
      vl.append(document.createTextNode(spec.fmt(deciding.feat[i])), h('em', null, spec.unit));
      feat.append(nm, vl);
    });
    body.appendChild(feat);

    body.appendChild(h('div', 'rule'));
    const kv = document.createElement('dl');
    kv.className = 'kv';
    const m = Telemetry.model;
    [
      ['On-device inference', deciding.infP50 + ' ms p50 · ' + deciding.infP95 + ' ms p95'],
      ['Inference rate', frame.sys.infRate + ' / min across the array'],
      ['Confirmation rule', frame.sys.confirmWindows + ' agreeing windows'],
      ['Transients rejected today', String(frame.sys.suppressed)],
      ['Model', m.algo + ' k=' + m.k + ' · ' + m.version],
      ['Training set', m.samples.toLocaleString('en-GB') + ' labelled samples'],
      ['Hold-out accuracy', m.accuracy + ' % · macro-F1 ' + m.f1],
      ['Flash footprint', m.size + ' KB of ' + '4 MB']
    ].forEach(function (r) {
      kv.append(h('dt', null, r[0]), h('dd', null, r[1]));
    });
    body.appendChild(kv);
  }

  /* ── thermal panel ─────────────────────────────────────────────────────── */

  function paintThermal(frame) {
    const body = document.getElementById('thermal-body');
    body.replaceChildren();

    const read = h('div', 'thermo-read');
    read.append(h('b', null, f1(frame.sys.temp)), h('span', null, '°C ambient'));
    body.appendChild(read);
    body.appendChild(h('span', 'micro', 'DHT22 mean across the array'));

    body.appendChild(h('div', 'rule'));
    body.appendChild(h('span', 'micro', 'BMP280 drift removed before inference'));

    const t = document.createElement('table');
    t.style.marginTop = '8px';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['Node', 'Raw', 'Drift', 'Corrected'].forEach(function (c) { hr.appendChild(h('th', null, c)); });
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = document.createElement('tbody');
    NODE_LIST.forEach(function (id) {
      const n = frame.nodes[id];
      const tr = document.createElement('tr');
      const c0 = h('td');
      const cell = h('span', 'cell-node');
      cell.append(badge(id));
      c0.appendChild(cell);
      /* Three decimals, and the drift in mbar to one. At 2 dp in bar a 1 mbar
         correction rounds away and the table reads as three identical columns
         doing nothing; at 0 dp in mbar, raw minus drift stops equalling
         corrected, which is worse — the row would contradict its own arithmetic. */
      tr.append(c0, h('td', null, n.pRaw.toFixed(3)),
        h('td', 'dim', (n.pOff >= 0 ? '+' : '−') + f1(Math.abs(n.pOff) * 1000) + ' mb'),
        h('td', null, n.p.toFixed(3)));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    body.appendChild(t);

    /* The claim has to hold at whatever the current temperature is. Asserting a
       1 mbar drift "would cross the minor-leak boundary" is false at 25 °C and
       true at 31 °C, so the magnitude decides which half of the sentence runs. */
    const mbar = Math.abs(frame.nodes.A.pOff) * 1000;
    const note = h('p', 'micro');
    note.style.cssText = 'margin-top:10px;white-space:normal;letter-spacing:.02em;text-transform:none;font-weight:400;font-size:11px;line-height:1.5';
    note.textContent = 'Calibrated at 25 °C, the BMP280s drift 4.2 mbar per °C above it. At ' +
      f1(frame.sys.temp) + ' °C that is ' + f1(mbar) + ' mbar' +
      (mbar >= 8
        ? ' — on its own enough to pull the pressure-deficit feature toward the minor-leak centroid.'
        : ', rising to about 25 mbar at the 31 °C daily high.') +
      ' The offset is subtracted before the feature vector is built.';
    body.appendChild(note);
  }

  /* ── node telemetry table ──────────────────────────────────────────────── */

  function paintNodes(frame) {
    const body = document.getElementById('nodes-body');
    body.replaceChildren();

    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['Node', 'Classification', 'Pressure', 'Flow', 'Vibration', 'Moisture', 'Temp', 'Link', 'Packet'].forEach(function (c) {
      hr.appendChild(h('th', null, c));
    });
    thead.appendChild(hr);
    t.appendChild(thead);

    const tb = document.createElement('tbody');
    NODE_LIST.forEach(function (id) {
      const n = frame.nodes[id];
      const st = STATE[n.cls];
      const tr = document.createElement('tr');

      const c0 = h('td');
      const cell = h('span', 'cell-node');
      const nm = h('div', 'node-name');
      nm.append(h('b', null, n.name), h('span', null, n.x + ' m · ' + n.lat.toFixed(5) + ' N, ' + n.lon.toFixed(5) + ' E'));
      cell.append(badge(id), nm);
      c0.appendChild(cell);

      const c1 = h('td');
      c1.style.textAlign = 'left';
      const tg = tag(st, st.name + ' ' + n.votes[Telemetry.classes.indexOf(n.cls)] + '/5');
      c1.appendChild(tg);

      const moist = h('td', n.moist > 25 ? null : 'dim', f1(n.moist) + ' %');
      if (n.moist > 25) moist.style.color = 'var(--crit-ink)';

      tr.append(
        c0, c1,
        h('td', null, f2(n.p) + ' bar'),
        h('td', null, f0(n.q) + ' L/min'),
        h('td', null, f0(n.vib) + ' mg'),
        moist,
        h('td', null, f1(n.temp) + ' °C'),
        h('td', 'dim', f0(n.rssi) + ' dBm'),
        h('td', 'dim', n.age + ' s')
      );
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    body.appendChild(t);
  }

  /* ── event log ─────────────────────────────────────────────────────────── */

  function paintEvents() {
    const body = document.getElementById('events-body');
    const list = Telemetry.alerts();
    body.replaceChildren();

    const wrap = h('div', 'events');
    list.forEach(function (a) {
      const st = a.cls === 'transient' ? STATE.watch : STATE[a.cls] || STATE.watch;
      const row = h('div', 'event');
      row.dataset.state = a.state === 'resolved' || a.state === 'suppressed' ? 'none' : st.key;

      const tcell = h('div', 'event-time');
      tcell.appendChild(h('span', 'event-hhmm', hhmm(a.t)));
      const dh = dayHint(a.t);
      if (dh) tcell.appendChild(h('span', 'event-day', dh));
      row.appendChild(tcell);

      const main = h('div', 'event-main');
      const title = a.cls === 'transient'
        ? 'Transient rejected · Node ' + a.node
        : st.name + ' · sub-segment ' + a.seg;
      main.appendChild(h('div', 'event-title', title));
      const bits = [];
      if (a.rate) bits.push(f0(a.rate) + ' L/min');
      if (a.pos != null) bits.push(f0(a.pos) + ' m from Node A');
      if (a.latency) bits.push('detected in ' + f1(a.latency) + ' s');
      if (a.moist) bits.push('moisture confirmed');
      if (a.cls === 'transient') bits.push('below the ' + Telemetry.model.confirm + '-window confirmation rule');
      if (a.state === 'resolved' && a.resolvedAt) bits.push('cleared after ' + dur(a.resolvedAt - a.t));
      main.appendChild(h('div', 'event-sub', bits.join(' · ')));
      row.appendChild(main);

      const right = h('div', 'event-right');
      const stateTag = a.state === 'active' ? tag(st, 'Active')
        : a.state === 'ack' ? tag('idle', 'Acknowledged')
        : a.state === 'suppressed' ? tag('idle', 'Suppressed')
        : tag('idle', 'Resolved');
      right.append(stateTag, h('span', 'event-sub', a.id));
      row.appendChild(right);

      wrap.appendChild(row);
    });
    body.appendChild(wrap);

    const active = list.filter(a => a.state === 'active').length;
    document.getElementById('events-meta').textContent =
      active ? active + ' active · ' + list.length + ' in 24 h' : list.length + ' in 24 h · none active';
  }

  /* ── table-view twins ──────────────────────────────────────────────────── */

  function buildTable(host, cols, rows) {
    host.replaceChildren();
    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    cols.forEach(c => hr.appendChild(h('th', null, c)));
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach(function (r) {
      const tr = document.createElement('tr');
      r.forEach(function (c, i) { tr.appendChild(h('td', i && typeof c === 'string' && /—/.test(c) ? 'dim' : null, c)); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    host.appendChild(t);
  }

  function paintTableViews(s) {
    const ids = activeNodes();
    const stride = Math.max(1, Math.floor(s.length / 40));
    const rows = s.filter((d, i) => i % stride === 0).reverse();

    if (view.tables.pressure) {
      buildTable(document.getElementById('table-pressure'),
        ['Time'].concat(ids.map(id => 'Node ' + id + ' (bar)')),
        rows.map(d => [clockOf(d.t)].concat(ids.map(id => f2(d['p' + id])))));
    }
    if (view.tables.flow) {
      buildTable(document.getElementById('table-flow'),
        ['Time', 'Inlet (L/min)', 'Outlet (L/min)', 'Deficit (L/min)'],
        rows.map(d => [clockOf(d.t), f0(d.qA), f0(d.qC), f1(d.qA - d.qC)]));
    }
    if (view.tables.vibration) {
      buildTable(document.getElementById('table-vibration'),
        ['Time'].concat(ids.map(id => 'Node ' + id + ' (mg)')),
        rows.map(d => [clockOf(d.t)].concat(ids.map(id => f0(d['v' + id])))));
    }
    if (view.tables.ribbon) {
      buildTable(document.getElementById('table-ribbon'),
        ['Time'].concat(ids.map(id => 'Node ' + id)),
        rows.map(d => [clockOf(d.t)].concat(ids.map(id => STATE[d['cls' + id]].name))));
    }
  }

  /* ── charts ────────────────────────────────────────────────────────────── */

  function paintCharts(force) {
    const frame = Telemetry.latest();
    if (!frame) return;
    if (view.hoverLock && !force) return;

    const s = Telemetry.series(view.range, 170);
    if (!s.length) return;
    const ids = activeNodes();
    const stateOf = frame.sys.pending ? STATE.watch : STATE[frame.sys.cls];

    /* schematic */
    Charts.schematic(document.getElementById('schematic'), frame, {
      segment: Telemetry.segment,
      colors: [NODE_COLOR.A, NODE_COLOR.B, NODE_COLOR.C],
      stateColor: stateOf.color,
      stateColorInk: stateOf.ink,
      motion: view.motion
    });

    /* nodal pressure — one axis, three series, direct end labels */
    Charts.line(document.getElementById('chart-pressure'), {
      data: s,
      series: ids.map(id => ({ key: 'p' + id, label: 'Node ' + id, color: NODE_COLOR[id], badge: id })),
      unit: 'bar', unitShort: 'bar', fmt: f2, height: 210, yPad: 0.22,
      ariaLabel: 'Pressure at each node over the selected window',
      tipNote: 'Temperature-corrected BMP280 readings'
    });

    /* flow balance — inlet vs outlet on one scale, the gap is the loss */
    Charts.line(document.getElementById('chart-flow'), {
      data: s,
      series: [
        { key: 'qA', label: 'Inlet (Node A)', color: NODE_COLOR.A, badge: 'A' },
        /* Outlet is drawn second and, at Normal, sits exactly on the inlet. Dashed,
           it lets the inlet show through instead of erasing it. */
        { key: 'qC', label: 'Outlet (Node C)', color: NODE_COLOR.C, badge: 'C', dash: '5 4' }
      ],
      band: { upper: 'qA', lower: 'qC', color: stateOf.color, label: 'Unaccounted flow' },
      unit: 'L/min', unitShort: 'L/min', fmt: f0, height: 210, yPad: 0.2,
      /* 70 L/min ≈ the smallest leak this array can localise. Holding the span
         open to at least that keeps a balanced segment looking balanced, and lets
         the gap that opens under a real leak be read against a stable scale. */
      minSpan: 70,
      ariaLabel: 'Inlet against outlet flow; the shaded gap is unaccounted water',
      tipNote: 'Shaded area = water entering but not leaving'
    });

    /* vibration — per node, current against window peak */
    Charts.columns(document.getElementById('chart-vibration'), {
      items: ids.map(function (id) {
        const n = frame.nodes[id];
        return {
          label: 'Node ' + id + ' · ' + n.name, badge: id, color: NODE_COLOR[id],
          value: n.vib, peak: Math.max.apply(null, s.map(d => d['v' + id])),
          note: 'MPU-6050 on the pipe wall'
        };
      }),
      unit: 'mg RMS', unitShort: 'mg', fmt: f0, height: 196,
      threshold: 34, thresholdLabel: 'jet-noise floor',
      ariaLabel: 'Vibration RMS per node against the jet-noise threshold'
    });

    /* classification ribbon */
    Charts.ribbon(document.getElementById('chart-ribbon'), {
      data: s,
      rows: ids.map(id => ({ key: 'cls' + id, label: 'Node ' + id, badge: id, color: NODE_COLOR[id] })),
      colorFor: function (cls) {
        return cls === 'normal'
          ? { color: 'var(--good)', opacity: .22 }
          : { color: STATE[cls].color, opacity: .92 };
      },
      nameFor: cls => STATE[cls].name,
      tipNote: 'Per-node output before the confirmation rule'
    });

    paintTableViews(s);
    view.lastChartPaint = Date.now();
  }

  /* ── per-frame paint ───────────────────────────────────────────────────── */

  let tileSeries = [];

  function onFrame(frame) {
    paintBanner(frame);
    paintAI(frame);
    paintThermal(frame);
    paintNodes(frame);
    paintEvents();

    if (Date.now() - view.lastChartPaint > 1900) {
      tileSeries = Telemetry.series(view.range, 60);
      paintCharts(false);
    }
    paintTiles(frame, tileSeries);

    document.getElementById('clock-local').textContent = clockOf(Date.now());
  }

  /* ── controls ──────────────────────────────────────────────────────────── */

  document.getElementById('range-picker').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    view.range = b.dataset.range;
    [...this.children].forEach(function (c) {
      const on = c === b;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
    });
    tileSeries = Telemetry.series(view.range, 60);
    paintCharts(true);
  });

  document.getElementById('node-picker').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-node]');
    if (!b) return;
    const id = b.dataset.node;
    if (view.nodes[id] && activeNodes().length === 1) return;   // never blank the view
    view.nodes[id] = !view.nodes[id];
    b.classList.toggle('is-on', view.nodes[id]);
    b.setAttribute('aria-pressed', String(view.nodes[id]));
    nodeLegend(document.getElementById('legend-pressure'));
    paintCharts(true);
  });

  document.getElementById('scenario-picker').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-scenario]');
    if (!b) return;
    Telemetry.setScenario(b.dataset.scenario);
    [...this.children].forEach(function (c) {
      const on = c === b;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
    });
  });

  document.querySelectorAll('button[data-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const key = btn.dataset.toggle;
      const on = !view.tables[key];
      view.tables[key] = on;
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'Chart' : 'Table';
      const chart = document.getElementById('chart-' + key);
      const table = document.getElementById('table-' + key);
      if (chart) chart.hidden = on;
      if (table) table.hidden = !on;
      paintCharts(true);
    });
  });

  document.getElementById('ack-btn').addEventListener('click', function () {
    Telemetry.acknowledge();
    paintEvents();
    paintBanner(Telemetry.latest());
  });

  /* Freeze chart repaints while the pointer is inside a plot, so a tooltip is
     never yanked out from under the reader. */
  document.querySelectorAll('.plot').forEach(function (p) {
    p.addEventListener('pointerenter', function () { view.hoverLock = true; });
    p.addEventListener('pointerleave', function () { view.hoverLock = false; });
  });

  let rsz;
  window.addEventListener('resize', function () {
    clearTimeout(rsz);
    rsz = setTimeout(() => paintCharts(true), 140);
  });

  /* ── boot ──────────────────────────────────────────────────────────────── */

  const flowLegend = document.getElementById('legend-flow');
  function paintFlowLegend() {
    flowLegend.replaceChildren();
    /* The dash in the key has to match the dash on the plot, or the legend is
       describing a chart that isn't there. */
    [['A', 'Inlet', false], ['C', 'Outlet', true]].forEach(function (r) {
      const lg = h('span', 'lg');
      const k = h('i', r[2] ? 'lk lk-dash' : 'lk');
      if (r[2]) k.style.cssText = 'background:linear-gradient(90deg,' + NODE_COLOR[r[0]] +
        ' 0 5px, transparent 5px 9px, ' + NODE_COLOR[r[0]] + ' 9px 14px)';
      else k.style.background = NODE_COLOR[r[0]];
      lg.append(k, h('span', null, r[1]));
      flowLegend.appendChild(lg);
    });
    const lg = h('span', 'lg');
    const k = h('i', 'rk');
    k.style.cssText = 'background:var(--crit);opacity:.4';
    lg.append(k, h('span', null, 'Unaccounted'));
    flowLegend.appendChild(lg);
  }

  function paintSchematicLegend() {
    const host = document.getElementById('schematic-legend');
    host.replaceChildren();
    [['lk', 'var(--s1)', 'Measured grade'], ['lk', 'var(--ink-3)', 'Expected grade']].forEach(function (r) {
      const lg = h('span', 'lg');
      const k = h('i', r[0]);
      k.style.background = r[1];
      if (r[1] === 'var(--ink-3)') k.style.opacity = '.6';
      lg.append(k, h('span', null, r[2]));
      host.appendChild(lg);
    });
  }

  /* With no stored choice, follow the operating system. Hard-defaulting to dark
     here would make the stylesheet's prefers-color-scheme block unreachable and
     hand a day-shift operator a dark console on first load. */
  applyTheme(readStored('pim-theme') || (
    window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  ));
  nodeLegend(document.getElementById('legend-pressure'));
  classLegend(document.getElementById('legend-ribbon'));
  paintFlowLegend();
  paintSchematicLegend();

  Telemetry.start();
  Telemetry.onFrame(onFrame);
  tileSeries = Telemetry.series(view.range, 60);
  paintCharts(true);
})();
