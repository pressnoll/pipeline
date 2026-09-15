/* ============================================================================
   charts.js — SVG chart primitives
   ----------------------------------------------------------------------------
   Hand-drawn rather than pulled from a library, because the marks have to obey
   fixed specs: 2px lines with round caps, ≥8px end markers carrying a 2px ring
   in the surface colour, 10 % area washes, solid hairline grids, a 2px surface
   gap between touching marks, and selective direct labels. Colours arrive as
   CSS custom properties so both themes swap in one place.

   Every chart ships a crosshair (or per-mark) hover layer, keyboard traversal
   with the same readout, and a table-view twin built by dashboard.js — a value
   is never reachable by hover alone.
   ========================================================================== */

const Charts = (function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) {
      if (attrs[k] === null || attrs[k] === undefined) continue;
      n.setAttribute(k, attrs[k]);
    }
    return n;
  }
  function txt(node, s) { node.textContent = s; return node; }

  /* Nice axis ticks — clean round numbers, never raw min/max. */
  function ticks(lo, hi, count) {
    if (!isFinite(lo) || !isFinite(hi) || lo === hi) { lo = lo - 1; hi = hi + 1; }
    const raw = (hi - lo) / Math.max(count, 2);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1) * mag;
    const start = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  const fmtClock = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtClockS = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  /* ── shared tooltip ────────────────────────────────────────────────────── */

  const tip = {
    node: null,
    get elx() { return this.node || (this.node = document.getElementById('tooltip')); },
    show: function (x, y, head, rows, note) {
      const t = this.elx;
      t.replaceChildren();
      const h = document.createElement('div');
      h.className = 'tt-head';
      t.appendChild(txt(h, head));
      rows.forEach(function (r) {
        const row = document.createElement('div');
        row.className = 'tt-row';
        const key = document.createElement('i');
        key.className = r.mark === 'rect' ? 'rk' : 'lk';
        key.style.background = r.color || 'transparent';
        const nm = document.createElement('span'); nm.className = 'nm';
        const vl = document.createElement('span'); vl.className = 'vl';
        row.append(key, txt(nm, r.label), txt(vl, r.value));
        t.appendChild(row);
      });
      if (note) {
        const n = document.createElement('div');
        n.className = 'tt-note';
        t.appendChild(txt(n, note));
      }
      t.hidden = false;
      const b = t.getBoundingClientRect();
      let left = x + 14, top = y - b.height / 2;
      if (left + b.width > window.innerWidth - 10) left = x - b.width - 14;
      top = Math.min(Math.max(top, 8), window.innerHeight - b.height - 8);
      t.style.left = left + 'px';
      t.style.top = top + 'px';
    },
    hide: function () { this.elx.hidden = true; }
  };

  /* ── line / area chart ─────────────────────────────────────────────────── */

  /* opts: { data, series:[{key,label,color,badge}], height, unit, fmt,
             band:{upper,lower,color,label}, area:bool, yPad, threshold,
             yDomain, tipNote } */
  function line(host, opts) {
    const data = opts.data || [];
    const W = Math.max(host.clientWidth || 480, 260);
    const H = opts.height || 208;
    /* The top margin carries the unit caption on its own line. At 14px the
       caption's baseline and the topmost tick label were 7px apart, so whenever
       the domain maximum landed exactly on the plot's top edge the two strings
       printed through each other ("L/MIN" over "1,300"). */
    const M = { t: 22, r: 58, b: 24, l: 46 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;

    host.replaceChildren();
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, tabindex: '0', role: 'img' });
    svg.setAttribute('aria-label', opts.ariaLabel || 'time series');
    if (!data.length) { host.appendChild(svg); return; }

    const keys = opts.series.map(s => s.key);
    let lo = Infinity, hi = -Infinity;
    data.forEach(function (d) {
      keys.forEach(function (k) { if (isFinite(d[k])) { lo = Math.min(lo, d[k]); hi = Math.max(hi, d[k]); } });
      if (opts.band) { lo = Math.min(lo, d[opts.band.lower]); hi = Math.max(hi, d[opts.band.upper]); }
    });
    if (opts.yDomain) { lo = opts.yDomain[0]; hi = opts.yDomain[1]; }
    else { const pad = (hi - lo || 1) * (opts.yPad || 0.16); lo -= pad; hi += pad; }
    /* A floor on the visible span. Without one, a series that is *correctly* flat
       gets its own instrument noise autoscaled to full plot height, and calm reads
       as chaos. minSpan is the smallest difference worth a whole panel: below it,
       the honest picture is two lines lying on top of each other. */
    if (opts.minSpan && hi - lo < opts.minSpan) {
      const mid = (hi + lo) / 2, half = opts.minSpan / 2;
      lo = mid - half; hi = mid + half;
    }
    if (opts.zeroFloor && lo > 0) lo = Math.max(0, lo - (hi - lo) * 0.05);

    const t0 = data[0].t, t1 = data[data.length - 1].t || t0 + 1;
    const sx = t => M.l + (t - t0) / (t1 - t0 || 1) * iw;
    const sy = v => M.t + ih - (v - lo) / (hi - lo || 1) * ih;

    /* grid + y ticks */
    const yt = ticks(lo, hi, 4);
    yt.forEach(function (v) {
      const y = sy(v);
      if (y < M.t - 1 || y > M.t + ih + 1) return;
      svg.appendChild(el('line', { class: 'gridline', x1: M.l, x2: M.l + iw, y1: y, y2: y }));
      const lb = el('text', { class: 'tick tick-y', x: M.l - 8, y: y + 3.5 });
      svg.appendChild(txt(lb, opts.fmt ? opts.fmt(v) : v));
    });
    svg.appendChild(el('line', { class: 'axisline', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));

    /* x ticks */
    const nX = Math.max(2, Math.min(6, Math.floor(iw / 96)));
    for (let i = 0; i <= nX; i++) {
      const t = t0 + (t1 - t0) * i / nX;
      const lb = el('text', { class: 'tick', x: sx(t), y: M.t + ih + 15, 'text-anchor': i === 0 ? 'start' : i === nX ? 'end' : 'middle' });
      svg.appendChild(txt(lb, fmtClock(t)));
    }
    /* Anchored to the top of the SVG, not to M.t: the caption and the tick
       labels share one right-aligned column, so the gap between them has to be
       the margin itself. Hanging it off M.t moved both together and kept the
       two strings 8px apart at an 11px font size. */
    const ut = el('text', { class: 'axis-title', x: M.l - 8, y: 10, 'text-anchor': 'end' });
    svg.appendChild(txt(ut, opts.unit || ''));

    /* differential band — the loss volume between inflow and outflow */
    if (opts.band) {
      let d = '';
      data.forEach(function (p, i) { d += (i ? 'L' : 'M') + sx(p.t) + ' ' + sy(p[opts.band.upper]); });
      for (let i = data.length - 1; i >= 0; i--) d += 'L' + sx(data[i].t) + ' ' + sy(data[i][opts.band.lower]);
      svg.appendChild(el('path', { d: d + 'Z', style: 'fill:' + opts.band.color + ';opacity:.16' }));
    }

    /* threshold rule */
    if (opts.threshold != null) {
      const y = sy(opts.threshold);
      if (y > M.t && y < M.t + ih) {
        svg.appendChild(el('line', { class: 'threshold', x1: M.l, x2: M.l + iw, y1: y, y2: y }));
        const lb = el('text', { class: 'plotlabel', x: M.l + 4, y: y - 5 });
        svg.appendChild(txt(lb, opts.thresholdLabel || ''));
      }
    }

    /* area washes then lines, so a wash never sits over a stroke */
    if (opts.area) {
      opts.series.forEach(function (s) {
        let d = '';
        data.forEach(function (p, i) { d += (i ? 'L' : 'M') + sx(p.t) + ' ' + sy(p[s.key]); });
        d += 'L' + sx(data[data.length - 1].t) + ' ' + (M.t + ih) + 'L' + sx(t0) + ' ' + (M.t + ih) + 'Z';
        svg.appendChild(el('path', { d: d, style: 'fill:' + s.color + ';opacity:.10' }));
      });
    }

    opts.series.forEach(function (s) {
      let d = '';
      data.forEach(function (p, i) { d += (i ? 'L' : 'M') + sx(p.t) + ' ' + sy(p[s.key]); });
      /* A series may opt into a dash. That is not decoration: where two series
         are expected to coincide for most of the day, a solid stroke drawn second
         hides the first completely and the panel silently loses a variable. With
         the upper one dashed, both colours stay visible along a shared path. */
      svg.appendChild(el('path', {
        class: 'serie', d: d,
        style: 'stroke:' + s.color + (s.dash ? ';stroke-dasharray:' + s.dash : '')
      }));
    });

    /* end markers + direct labels (the relief channel for low-contrast hues) */
    const last = data[data.length - 1];
    const placed = opts.series.map(function (s) { return { s: s, y: sy(s.key in last ? last[s.key] : lo), v: last[s.key] }; })
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) {
      if (placed[i].y - placed[i - 1].y < 13) placed[i].y = placed[i - 1].y + 13;
    }
    placed.forEach(function (p) {
      const cy = sy(p.v);
      svg.appendChild(el('circle', { class: 'endcap', cx: sx(last.t), cy: cy, r: 4.2, style: 'fill:' + p.s.color }));
      if (Math.abs(p.y - cy) > 2) {
        svg.appendChild(el('path', {
          d: 'M' + (sx(last.t) + 5) + ' ' + cy + 'L' + (M.l + iw + 9) + ' ' + p.y,
          style: 'fill:none;stroke:' + p.s.color + ';stroke-width:1;opacity:.5'
        }));
      }
      const key = el('rect', { x: M.l + iw + 10, y: p.y - 5.5, width: 11, height: 11, rx: 2.5, style: 'fill:' + p.s.color });
      svg.appendChild(key);
      const bg = el('text', { x: M.l + iw + 15.5, y: p.y + 3, 'text-anchor': 'middle', style: 'font-size:8.5px;font-weight:750;fill:#fff' });
      svg.appendChild(txt(bg, p.s.badge || ''));
      const lb = el('text', { class: 'endlabel', x: M.l + iw + 25, y: p.y + 3.5 });
      svg.appendChild(txt(lb, opts.fmt ? opts.fmt(p.v) : Math.round(p.v)));
    });

    /* hover layer: the crosshair finds the X, one tooltip lists every series */
    const cross = el('line', { class: 'crosshair', y1: M.t, y2: M.t + ih, style: 'display:none' });
    svg.appendChild(cross);
    const dots = el('g', { style: 'display:none' });
    svg.appendChild(dots);

    function readout(i, cx, cy) {
      const p = data[i];
      cross.setAttribute('x1', sx(p.t)); cross.setAttribute('x2', sx(p.t));
      cross.style.display = '';
      dots.replaceChildren();
      opts.series.forEach(function (s) {
        dots.appendChild(el('circle', { class: 'endcap', cx: sx(p.t), cy: sy(p[s.key]), r: 4.2, style: 'fill:' + s.color }));
      });
      dots.style.display = '';
      const rows = opts.series.map(function (s) {
        return { color: s.color, label: s.label, value: (opts.fmt ? opts.fmt(p[s.key]) : Math.round(p[s.key])) + (opts.unitShort ? ' ' + opts.unitShort : '') };
      });
      if (opts.band) {
        rows.push({ color: opts.band.color, mark: 'rect', label: opts.band.label, value: (opts.fmt ? opts.fmt(p[opts.band.upper] - p[opts.band.lower]) : '') + (opts.unitShort ? ' ' + opts.unitShort : '') });
      }
      tip.show(cx, cy, fmtClockS(p.t), rows, opts.tipNote);
    }

    let idx = data.length - 1;
    const hit = el('rect', { x: M.l, y: M.t, width: iw, height: ih, style: 'fill:transparent' });
    svg.appendChild(hit);
    function nearest(px) {
      const t = t0 + (px - M.l) / iw * (t1 - t0);
      let best = 0, bd = Infinity;
      data.forEach(function (p, i) { const dd = Math.abs(p.t - t); if (dd < bd) { bd = dd; best = i; } });
      return best;
    }
    svg.addEventListener('pointermove', function (e) {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (W / r.width);
      if (px < M.l || px > M.l + iw) return;
      idx = nearest(px);
      readout(idx, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', function () { cross.style.display = 'none'; dots.style.display = 'none'; tip.hide(); });
    svg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      idx = Math.min(data.length - 1, Math.max(0, idx + (e.key === 'ArrowRight' ? 1 : -1)));
      const r = svg.getBoundingClientRect();
      readout(idx, r.left + sx(data[idx].t) * (r.width / W), r.top + r.height / 2);
    });
    svg.addEventListener('blur', function () { cross.style.display = 'none'; dots.style.display = 'none'; tip.hide(); });

    host.appendChild(svg);
  }

  /* ── column chart (per-node instantaneous + window peak) ───────────────── */

  /* opts: { items:[{label,badge,color,value,peak,note}], height, unit, fmt,
             threshold, thresholdLabel, max } */
  function columns(host, opts) {
    const items = opts.items || [];
    const W = Math.max(host.clientWidth || 300, 200);
    const H = opts.height || 190;
    const M = { t: 16, r: 12, b: 34, l: 42 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;

    host.replaceChildren();
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' });
    svg.setAttribute('aria-label', opts.ariaLabel || 'per-node comparison');

    const hi = opts.max || Math.max(opts.threshold || 0, ...items.map(d => Math.max(d.value, d.peak || 0))) * 1.24;
    const sy = v => M.t + ih - (v / (hi || 1)) * ih;

    ticks(0, hi, 4).forEach(function (v) {
      const y = sy(v);
      svg.appendChild(el('line', { class: 'gridline', x1: M.l, x2: M.l + iw, y1: y, y2: y }));
      const lb = el('text', { class: 'tick tick-y', x: M.l - 8, y: y + 3.5 });
      svg.appendChild(txt(lb, opts.fmt ? opts.fmt(v) : v));
    });
    svg.appendChild(el('line', { class: 'axisline', x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));
    const ut = el('text', { class: 'axis-title', x: M.l - 8, y: M.t - 4, 'text-anchor': 'end' });
    svg.appendChild(txt(ut, opts.unit || ''));

    if (opts.threshold != null) {
      const y = sy(opts.threshold);
      svg.appendChild(el('line', { class: 'threshold', x1: M.l, x2: M.l + iw, y1: y, y2: y }));
      /* The caption for the rule goes in the header strip with its own dashed
         swatch, not on the rule itself. A bar that *reaches* the threshold is
         precisely the case an operator is scanning for, and it puts its own
         value label exactly where an on-rule caption sits — the two collided
         into an unreadable pile-up in the one state that matters most. */
      const lb = el('text', { class: 'plotlabel', x: M.l + iw - 22, y: M.t - 4, 'text-anchor': 'end' });
      svg.appendChild(txt(lb, opts.thresholdLabel || ''));
      svg.appendChild(el('line', {
        class: 'threshold', x1: M.l + iw - 18, x2: M.l + iw, y1: M.t - 8, y2: M.t - 8
      }));
    }

    const band = iw / items.length;
    const bw = Math.min(24, band * 0.42);

    items.forEach(function (d, i) {
      const cx = M.l + band * (i + 0.5);
      const x = cx - bw / 2;
      const y = sy(d.value);
      const h = Math.max(M.t + ih - y, 1.5);
      const r = Math.min(4, bw / 2, h);
      /* rounded data-end, square at the baseline */
      const dPath = 'M' + x + ' ' + (M.t + ih) + 'V' + (y + r) +
        'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r + 'h' + (bw - 2 * r) +
        'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'V' + (M.t + ih) + 'Z';
      svg.appendChild(el('path', { d: dPath, style: 'fill:' + d.color }));

      if (d.peak != null && d.peak > d.value) {
        svg.appendChild(el('line', {
          x1: cx - bw / 2 - 3, x2: cx + bw / 2 + 3, y1: sy(d.peak), y2: sy(d.peak),
          style: 'stroke:' + d.color + ';stroke-width:2;opacity:.42;stroke-linecap:round'
        }));
      }

      const val = el('text', { class: 'endlabel', x: cx, y: y - 8, 'text-anchor': 'middle' });
      svg.appendChild(txt(val, opts.fmt ? opts.fmt(d.value) : Math.round(d.value)));

      const key = el('rect', { x: cx - 8, y: M.t + ih + 8, width: 16, height: 16, rx: 3.5, style: 'fill:' + d.color });
      svg.appendChild(key);
      const bg = el('text', { x: cx, y: M.t + ih + 19.5, 'text-anchor': 'middle', style: 'font-size:10px;font-weight:750;fill:#fff' });
      svg.appendChild(txt(bg, d.badge));

      /* hit target spans the whole band, not the painted pixels */
      const hit = el('rect', { x: M.l + band * i, y: M.t, width: band, height: ih + 26, style: 'fill:transparent' });
      hit.setAttribute('tabindex', '0');
      const rows = [{ color: d.color, mark: 'rect', label: 'Current', value: (opts.fmt ? opts.fmt(d.value) : d.value) + ' ' + (opts.unitShort || '') }];
      if (d.peak != null) rows.push({ color: d.color, label: 'Window peak', value: (opts.fmt ? opts.fmt(d.peak) : d.peak) + ' ' + (opts.unitShort || '') });
      function show(e) {
        const r = hit.getBoundingClientRect();
        tip.show(e.clientX || r.left + r.width / 2, e.clientY || r.top + 20, d.label, rows, d.note);
      }
      hit.addEventListener('pointermove', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', () => tip.hide());
      hit.addEventListener('blur', () => tip.hide());
      svg.appendChild(hit);
    });

    host.appendChild(svg);
  }

  /* ── classification ribbon ─────────────────────────────────────────────── */

  /* opts: { data, rows:[{key,label,badge,color}], height, colorFor } */
  function ribbon(host, opts) {
    const data = opts.data || [];
    const W = Math.max(host.clientWidth || 320, 220);
    const rowH = 40, gap = 14;
    const M = { t: 8, r: 10, b: 24, l: 30 };
    const H = M.t + opts.rows.length * (rowH + gap) - gap + M.b;
    const iw = W - M.l - M.r;

    host.replaceChildren();
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' });
    svg.setAttribute('aria-label', 'classification state over time per node');
    if (!data.length) { host.appendChild(svg); return; }

    const t0 = data[0].t, t1 = data[data.length - 1].t;

    opts.rows.forEach(function (r, ri) {
      const y = M.t + ri * (rowH + gap);
      const badge = el('rect', { x: 0, y: y + 12, width: 16, height: 16, rx: 3.5, style: 'fill:' + r.color });
      svg.appendChild(badge);
      const bt = el('text', { x: 8, y: y + 23.5, 'text-anchor': 'middle', style: 'font-size:10px;font-weight:750;fill:#fff' });
      svg.appendChild(txt(bt, r.badge));

      /* Contiguous buckets of the same class merge into one run. A rect per
         bucket would speckle a calm hour into hundreds of identical stripes;
         what an operator reads off this lane is *duration in a state*, so the
         run — not the sample — is the mark. */
      let i = 0;
      while (i < data.length) {
        const cls = data[i][r.key];
        let j = i + 1;
        while (j < data.length && data[j][r.key] === cls) j++;
        const fill = opts.colorFor(cls);
        /* The 1.6px inset is a state-change separator, not a uniform gap: it is
           only ever inset where the next run differs. */
        const inset = j < data.length ? 1.6 : 0;
        svg.appendChild(el('rect', {
          x: M.l + iw * (i / data.length), y: y, height: rowH, rx: 2,
          width: Math.max(iw * ((j - i) / data.length) - inset, 0.9),
          style: 'fill:' + fill.color + ';opacity:' + fill.opacity
        }));
        i = j;
      }

      /* a hairline baseline under each lane keeps "normal" legible as a state */
      svg.appendChild(el('line', { class: 'gridline', x1: M.l, x2: M.l + iw, y1: y + rowH + 1.5, y2: y + rowH + 1.5 }));
    });

    const nX = Math.max(2, Math.min(5, Math.floor(iw / 90)));
    for (let i = 0; i <= nX; i++) {
      const t = t0 + (t1 - t0) * i / nX;
      const lb = el('text', { class: 'tick', x: M.l + iw * i / nX, y: H - 8, 'text-anchor': i === 0 ? 'start' : i === nX ? 'end' : 'middle' });
      svg.appendChild(txt(lb, fmtClock(t)));
    }

    const hit = el('rect', { x: M.l, y: M.t, width: iw, height: H - M.t - M.b, style: 'fill:transparent' });
    svg.appendChild(hit);
    svg.addEventListener('pointermove', function (e) {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (W / r.width);
      if (px < M.l || px > M.l + iw) return;
      const i = Math.min(data.length - 1, Math.max(0, Math.floor((px - M.l) / (iw / data.length))));
      const d = data[i];
      tip.show(e.clientX, e.clientY, fmtClockS(d.t), opts.rows.map(function (r) {
        return { color: opts.colorFor(d[r.key]).color, mark: 'rect', label: r.label, value: opts.nameFor(d[r.key]) };
      }), opts.tipNote);
    });
    svg.addEventListener('pointerleave', () => tip.hide());

    host.appendChild(svg);
  }

  /* ── sparkline (stat tiles) ────────────────────────────────────────────── */

  function spark(values, o) {
    o = o || {};
    const w = o.w || 92, h = o.h || 26;
    const svg = el('svg', { class: 'spark', viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, 'aria-hidden': 'true' });
    const v = values.filter(isFinite);
    if (v.length < 2) return svg;
    const lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    const sy = x => h - 3 - (hi === lo ? 0.5 : (x - lo) / (hi - lo)) * (h - 6);
    const sx = i => 2 + i / (v.length - 1) * (w - 4 - 5);
    let d = '';
    v.forEach(function (x, i) { d += (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(x).toFixed(1); });
    svg.appendChild(el('path', { d: d, style: 'fill:none;stroke:' + (o.color || 'var(--ink-3)') + ';stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round;opacity:' + (o.dim || .55) }));
    svg.appendChild(el('circle', {
      cx: sx(v.length - 1).toFixed(1), cy: sy(v[v.length - 1]).toFixed(1), r: 3,
      style: 'fill:' + (o.accent || 'var(--accent)') + ';stroke:var(--surface);stroke-width:2'
    }));
    return svg;
  }

  /* ── segment schematic + hydraulic grade line ──────────────────────────
     One x-axis serves both the HGL plot and the pipe below it, so the gradient
     break lines up with the leak marker. That alignment is the whole point:
     the reader sees *why* the localiser put the leak where it did.          */

  function schematic(host, frame, opts) {
    const nodes = ['A', 'B', 'C'].map(id => frame.nodes[id]);
    const seg = opts.segment;
    const W = Math.max(host.clientWidth || 640, 380);
    /* This is the panel that sits beside the classifier column, so it is sized to
       fill that row. The extra height all goes to the grade-line plot — a taller
       plot is what makes a gradient break of a few hundredths of a bar visible. */
    const H = 420;
    const M = { t: 16, r: 18, b: 8, l: 46 };
    const iw = W - M.l - M.r;
    /* hgl.top leaves room above the first gridline for the unit caption — at the
       plot's own top margin the caption and the top tick label overlapped. */
    const hgl = { top: 34, h: 222 };
    const pipeY = 300, pipeH = 15;

    host.replaceChildren();
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' });
    const sx = x => M.l + (x / seg.length) * iw;

    /* ---- hydraulic grade line ---- */
    const ps = nodes.map(n => n.p);
    const lo = Math.min.apply(null, ps) - 0.22, hi = Math.max.apply(null, ps) + 0.12;
    const sy = v => hgl.top + hgl.h - (v - lo) / (hi - lo || 1) * hgl.h;

    ticks(lo, hi, 3).forEach(function (v) {
      const y = sy(v);
      if (y < hgl.top - 1 || y > hgl.top + hgl.h + 1) return;
      svg.appendChild(el('line', { class: 'gridline', x1: M.l, x2: M.l + iw, y1: y, y2: y }));
      const lb = el('text', { class: 'tick tick-y', x: M.l - 8, y: y + 3.5 });
      svg.appendChild(txt(lb, v.toFixed(1)));
    });
    const ut = el('text', { class: 'axis-title', x: M.l - 8, y: hgl.top - 12, 'text-anchor': 'end' });
    svg.appendChild(txt(ut, 'bar'));

    /* the no-leak reference gradient: a straight line inlet → design outlet */
    const refOut = nodes[0].p - 1.21 * Math.pow(frame.nodes.A.q / seg.qNominal, 1.852);
    svg.appendChild(el('path', {
      d: 'M' + sx(0) + ' ' + sy(nodes[0].p) + 'L' + sx(seg.length) + ' ' + sy(refOut),
      style: 'fill:none;stroke:var(--ink-3);stroke-width:1;opacity:.45'
    }));
    const rl = el('text', { class: 'plotlabel', x: sx(seg.length) - 2, y: sy(refOut) + 13, 'text-anchor': 'end' });
    svg.appendChild(txt(rl, 'expected gradient'));

    /* measured profile — a break at the leak is the signature */
    const pos = frame.sys.pos;
    const pts = [{ x: 0, p: nodes[0].p }];
    if (pos != null && frame.sys.cls !== 'normal') {
      const iSeg = pos < 620 ? 0 : 1;
      const a = nodes[iSeg], b = nodes[iSeg + 1];
      const f = (pos - a.x) / (b.x - a.x);
      if (iSeg === 1) pts.push({ x: 620, p: nodes[1].p });
      pts.push({ x: pos, p: a.p + (b.p - a.p) * f * 0.62 });
      if (iSeg === 0) pts.push({ x: 620, p: nodes[1].p });
      pts.push({ x: 1240, p: nodes[2].p });
    } else {
      pts.push({ x: 620, p: nodes[1].p }, { x: 1240, p: nodes[2].p });
    }
    let hd = '';
    pts.forEach(function (p, i) { hd += (i ? 'L' : 'M') + sx(p.x) + ' ' + sy(p.p); });
    svg.appendChild(el('path', { d: hd, style: 'fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round' }));

    nodes.forEach(function (n, i) {
      svg.appendChild(el('circle', { class: 'endcap', cx: sx(n.x), cy: sy(n.p), r: 4.2, style: 'fill:' + opts.colors[i] }));
      const lb = el('text', { class: 'endlabel', x: sx(n.x) + (i === 2 ? -6 : 8), y: sy(n.p) - 9, 'text-anchor': i === 2 ? 'end' : 'start' });
      svg.appendChild(txt(lb, n.p.toFixed(2)));
    });

    /* ---- the pipe ---- */
    svg.appendChild(el('rect', { class: 'pipe-wall', x: M.l, y: pipeY, width: iw, height: pipeH, rx: 2 }));
    const flow = el('line', {
      class: 'pipe-flow' + (opts.motion ? ' pipe-flow-anim' : ''),
      x1: M.l + 4, x2: M.l + iw - 4, y1: pipeY + pipeH / 2, y2: pipeY + pipeH / 2,
      'stroke-dasharray': '9 19'
    });
    svg.appendChild(flow);

    /* sub-segment imbalance bars, directly under the length they describe */
    [{ a: 0, b: 620, v: frame.sys.imbalAB, lab: 'A–B' }, { a: 620, b: 1240, v: frame.sys.imbalBC, lab: 'B–C' }]
      .forEach(function (sg) {
        const active = frame.sys.subseg === sg.lab && frame.sys.cls !== 'normal';
        const y = pipeY + pipeH + 7;
        svg.appendChild(el('line', {
          x1: sx(sg.a) + 2, x2: sx(sg.b) - 2, y1: y, y2: y,
          style: 'stroke:' + (active ? opts.stateColor : 'var(--axis)') + ';stroke-width:' + (active ? 3 : 1.5) + ';stroke-linecap:round;opacity:' + (active ? 1 : .6)
        }));
        const lb = el('text', { class: 'chiplabel', x: (sx(sg.a) + sx(sg.b)) / 2, y: y + 14, 'text-anchor': 'middle' });
        svg.appendChild(txt(lb, sg.lab + '  Δq ' + (sg.v > 0 ? '+' : '') + sg.v.toFixed(1)));
      });

    /* ---- node heads ---- */
    nodes.forEach(function (n, i) {
      const x = sx(n.x);
      svg.appendChild(el('line', { class: 'node-stem', x1: x, x2: x, y1: sy(n.p) + 6, y2: pipeY - 4 }));
      const anchor = i === 0 ? 'start' : i === 2 ? 'end' : 'middle';
      const bx = i === 0 ? x : i === 2 ? x - 16 : x - 8;
      svg.appendChild(el('rect', { x: bx, y: pipeY - 24, width: 16, height: 16, rx: 3.5, style: 'fill:' + opts.colors[i] }));
      const bt = el('text', { x: bx + 8, y: pipeY - 12.5, 'text-anchor': 'middle', style: 'font-size:10px;font-weight:750;fill:var(--surface)' });
      svg.appendChild(txt(bt, n.id));
      const q = el('text', { class: 'chiptext', x: i === 0 ? bx + 21 : i === 2 ? bx - 5 : bx + 21, y: pipeY - 11, 'text-anchor': i === 2 ? 'end' : 'start' });
      svg.appendChild(txt(q, Math.round(n.q) + ' L/min'));

      const dl = el('text', { class: 'chiplabel', x: x, y: H - 12, 'text-anchor': anchor });
      svg.appendChild(txt(dl, n.x + ' m'));
      svg.appendChild(el('line', { class: 'axisline', x1: x, x2: x, y1: H - 26, y2: H - 21 }));
    });
    svg.appendChild(el('line', { class: 'axisline', x1: M.l, x2: M.l + iw, y1: H - 26, y2: H - 26 }));

    /* ---- leak marker ---- */
    if (pos != null && frame.sys.cls !== 'normal') {
      const x = sx(pos);
      const cy = pipeY + pipeH / 2;
      const sigma = frame.sys.sigma || 30;
      /* the ±1σ interval drawn on the pipe, so the number has a picture */
      svg.appendChild(el('line', {
        x1: Math.max(sx(0), sx(pos - sigma)), x2: Math.min(sx(seg.length), sx(pos + sigma)),
        y1: cy, y2: cy,
        style: 'stroke:' + opts.stateColor + ';stroke-width:' + pipeH + ';opacity:.22'
      }));
      if (opts.motion) svg.appendChild(el('circle', { class: 'leak-ring', cx: x, cy: cy, r: 5, style: 'fill:none;stroke:' + opts.stateColor + ';stroke-width:1.6' }));
      svg.appendChild(el('path', {
        d: 'M' + x + ' ' + (cy - 6) + 'L' + (x + 6) + ' ' + cy + 'L' + x + ' ' + (cy + 6) + 'L' + (x - 6) + ' ' + cy + 'Z',
        style: 'fill:' + opts.stateColor + ';stroke:var(--surface);stroke-width:1.5'
      }));
      /* escaping water, three short strokes downward */
      [-4, 0, 4].forEach(function (dx, k) {
        svg.appendChild(el('line', {
          x1: x + dx * .6, x2: x + dx * 1.9, y1: cy + 8, y2: cy + 15 + (k === 1 ? 4 : 0),
          style: 'stroke:' + opts.stateColor + ';stroke-width:1.4;opacity:.62;stroke-linecap:round'
        }));
      });
      svg.appendChild(el('line', { x1: x, x2: x, y1: hgl.top + hgl.h + 6, y2: pipeY - 2, style: 'stroke:' + opts.stateColor + ';stroke-width:1;opacity:.5' }));
      const cl = el('text', { class: 'endlabel', x: Math.min(x + 10, M.l + iw - 4), y: pipeY - 32, 'text-anchor': x > M.l + iw - 150 ? 'end' : 'start', style: 'fill:' + opts.stateColorInk });
      svg.appendChild(txt(cl, Math.round(pos) + ' m  ±' + Math.round(sigma) + ' m'));
    }

    host.appendChild(svg);
  }

  return { line: line, columns: columns, ribbon: ribbon, spark: spark, schematic: schematic, ticks: ticks, tip: tip };
})();
