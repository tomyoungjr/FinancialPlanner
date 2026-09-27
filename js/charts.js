/* Small SVG charts, no libraries (the app works offline). */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceTicks(max, count) {
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  /**
   * Fan chart: for each series, a 10th-90th percentile wash, a 2px median line,
   * and a thin dashed "bad case" (10th percentile) line. Crosshair tooltip on hover.
   * series: [{name, color (CSS var), rows: [{age, p10, p25, p50, p75, p90}]}]
   */
  function fanChart(container, series, opts) {
    const fmt = opts.format;
    // Axis ticks are chosen in displayed units, so Hide $ still shows round numbers
    // (otherwise the hidden factor could be read off the axis).
    const scale = opts.scale || 1, axisFmt = opts.axisFormat || fmt;
    container.innerHTML = '';
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = series.map(s =>
      `<span><span class="line-key" style="background:${s.color}"></span>${s.name}</span>`).join('') +
      '<span class="muted">solid = typical (median) · dashed = bad case (10th percentile) · shaded = middle 80% of futures</span>';
    container.appendChild(legend);

    const wrap = document.createElement('div');
    wrap.className = 'chart';
    container.appendChild(wrap);
    const W = 900, H = opts.height || 340, m = { l: 56, r: 12, t: 10, b: 30 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Chart' }, wrap);

    const ages = series.flatMap(s => s.rows.map(r => r.age));
    const x0 = Math.min(...ages), x1 = Math.max(...ages);
    // Cap the y-axis at the larger 75th percentile so a few huge outcomes don't flatten the story.
    const cap = Math.max(...series.flatMap(s => s.rows.map(r => r.p75))) * 1.35;
    const ticks = niceTicks(cap * scale, 5).map(v => v / scale);
    const yMax = ticks[ticks.length - 1];
    const X = a => m.l + (a - x0) / Math.max(1, x1 - x0) * (W - m.l - m.r);
    const Y = v => m.t + (1 - Math.min(v, yMax) / yMax) * (H - m.t - m.b);

    const axis = el('g', { class: 'axis' }, svg);
    ticks.forEach(v => {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'gridline' }, axis);
      el('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, axis).textContent = axisFmt(v);
    });
    const step = (x1 - x0) > 30 ? 5 : 2;
    for (let a = Math.ceil(x0 / step) * step; a <= x1; a += step) {
      el('text', { x: X(a), y: H - 8, 'text-anchor': 'middle' }, axis).textContent = a;
    }

    const clip = 'clip' + Math.random().toString(36).slice(2);
    const defs = el('defs', {}, svg);
    const cp = el('clipPath', { id: clip }, defs);
    el('rect', { x: m.l, y: m.t - 2, width: W - m.l - m.r, height: H - m.t - m.b + 2 }, cp);
    const plot = el('g', { 'clip-path': `url(#${clip})` }, svg);

    series.forEach(s => {
      const top = s.rows.map(r => `${X(r.age)},${Y(r.p90)}`);
      const bot = s.rows.slice().reverse().map(r => `${X(r.age)},${Y(r.p10)}`);
      el('polygon', { points: top.concat(bot).join(' '), fill: s.color, 'fill-opacity': 0.10 }, plot);
    });
    series.forEach(s => {
      const line = key => s.rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.age)},${Y(r[key])}`).join('');
      el('path', { d: line('p10'), fill: 'none', stroke: s.color, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, plot);
      el('path', { d: line('p50'), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, plot);
    });

    // hover layer
    const cross = el('line', { y1: m.t, y2: H - m.b, stroke: 'var(--text-3)', 'stroke-width': 1, visibility: 'hidden' }, svg);
    const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
    const tip = document.getElementById('tooltip');
    function move(evt) {
      const pt = evt.touches ? evt.touches[0] : evt;
      const box = svg.getBoundingClientRect();
      const sx = (pt.clientX - box.left) / box.width * W;
      const age = Math.round(x0 + (sx - m.l) / (W - m.l - m.r) * (x1 - x0));
      const rows = series.map(s => s.rows.find(r => r.age === age));
      if (!rows.some(Boolean)) return;
      cross.setAttribute('x1', X(age)); cross.setAttribute('x2', X(age)); cross.setAttribute('visibility', 'visible');
      dots.forEach((d, i) => {
        if (!rows[i]) { d.setAttribute('visibility', 'hidden'); return; }
        d.setAttribute('cx', X(age)); d.setAttribute('cy', Y(rows[i].p50)); d.setAttribute('visibility', 'visible');
      });
      tip.innerHTML = `<div class="tt-title">Age ${age}</div>` + series.map((s, i) => rows[i] ?
        `<div class="tt-row"><span><span class="key" style="background:${s.color}"></span>${s.name}</span></div>
         <div class="tt-row"><span>&nbsp;&nbsp;typical</span><b>${fmt(rows[i].p50)}</b></div>
         <div class="tt-row"><span>&nbsp;&nbsp;bad case</span><span>${fmt(rows[i].p10)}</span></div>` : '').join('');
      tip.style.display = 'block';
      const tx = pt.pageX + 16 + tip.offsetWidth > window.scrollX + window.innerWidth ? pt.pageX - tip.offsetWidth - 16 : pt.pageX + 16;
      tip.style.left = tx + 'px';
      tip.style.top = (pt.pageY - tip.offsetHeight / 2) + 'px';
    }
    function leave() {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
      tip.style.display = 'none';
    }
    hit.addEventListener('mousemove', move);
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchend', leave);
  }

  /** Inline diverging bar for a change in percentage points. */
  function deltaBar(delta, scale) {
    const w = Math.min(50, Math.abs(delta) / scale * 50);
    const cls = delta >= 0 ? 'pos' : 'neg';
    return `<div class="dbar" aria-hidden="true"><div class="zero"></div><div class="fill ${cls}" style="width:${w}%"></div></div>`;
  }

  root.Charts = { fanChart, deltaBar };
})(this);
