// ─────────────────────────────────────────────────────────────────────────
//  charts.js — schlanke, handgezeichnete SVG-Charts (keine Abhängigkeiten)
//  Dünne Marken · zurückhaltendes Raster · Hover-Crosshair + Tooltip.
// ─────────────────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
const C = {
  weight: '#BE821A', gold: '#F2B138', muscle: '#20A886', water: '#6C8FE8', fat: '#E44A6C',
  ink3: '#6C7583', line: 'rgba(255,255,255,.07)', ink: '#EEF1F5', ink2: '#AAB3C0',
};

// ── kleine Helfer ──────────────────────────────────────────────────────────
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  for (const c of [].concat(kids)) if (c) n.appendChild(c);
  return n;
};
const dayNum = (iso) => Math.floor(new Date(iso + 'T00:00:00Z').getTime() / 86400000);
const fmt = (v, d = 1) => v == null || Number.isNaN(v) ? '–' : v.toFixed(d).replace('.', ',');
const fmtInt = (v) => v == null ? '–' : Math.round(v).toLocaleString('de-DE');
const shortDate = (iso) => { const [, m, d] = iso.split('-'); return `${d}.${m}.`; };

function scale(dmin, dmax, rmin, rmax) {
  const d = (dmax - dmin) || 1;
  return (v) => rmin + ((v - dmin) / d) * (rmax - rmin);
}

// Catmull-Rom → glatte Bézier-Kurve (für Trendlinien)
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}
const linePath = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');

function dims(container, fallbackH) {
  const w = container.clientWidth || 600;
  const h = container.clientHeight || fallbackH;
  return { w, h };
}

function niceTicks(min, max, count = 4) {
  const span = (max - min) || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// gemeinsamer Tooltip-Layer
function ensureTooltip(container) {
  let t = container.querySelector('.tooltip');
  if (!t) { t = document.createElement('div'); t.className = 'tooltip'; container.appendChild(t); }
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Gewichts-Chart: Rohpunkte + Trend + Plan + Ziellinie
// ═══════════════════════════════════════════════════════════════════════════
export function renderWeightChart(container, a) {
  container.querySelector('svg')?.remove();
  const { w, h } = dims(container, 320);
  const pad = { t: 16, r: 16, b: 26, l: 40 };
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });

  const wser = a.series.weight || [];
  const plan = a.series.plan || [];
  if (!wser.length) { container.appendChild(svg); return; }

  const allX = [...wser.map(p => dayNum(p.date)), ...plan.map(p => dayNum(p.date))];
  const xmin = Math.min(...allX), xmax = Math.max(...allX);
  const ys = [
    ...wser.map(p => p.weight), ...wser.map(p => p.trend),
    ...plan.map(p => p.weight), a.goalWeight,
  ].filter(v => v != null);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  const padY = (ymax - ymin) * 0.12 || 1; ymin -= padY; ymax += padY;

  const sx = scale(xmin, xmax, pad.l, w - pad.r);
  const sy = scale(ymin, ymax, h - pad.b, pad.t);

  // horizontales Raster + y-Beschriftung
  for (const tk of niceTicks(ymin, ymax, 4)) {
    const y = sy(tk);
    svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, class: 'grid-line' }));
    svg.appendChild(el('text', { x: pad.l - 8, y: y + 3, 'text-anchor': 'end', class: 'axis-label' },
      [document.createTextNode(fmt(tk, 0))]));
  }
  // x-Beschriftung (jede ~Woche)
  const step = Math.max(1, Math.round((xmax - xmin) / 6));
  for (let d = xmin; d <= xmax; d += step) {
    const iso = new Date(d * 86400000).toISOString().slice(0, 10);
    svg.appendChild(el('text', { x: sx(d), y: h - pad.b + 16, 'text-anchor': 'middle', class: 'axis-label' },
      [document.createTextNode(shortDate(iso))]));
  }

  // Ziellinie
  const gy = sy(a.goalWeight);
  svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: gy, y2: gy,
    stroke: C.gold, 'stroke-width': 1, 'stroke-dasharray': '2 5', opacity: .55 }));
  svg.appendChild(el('text', { x: w - pad.r, y: gy - 6, 'text-anchor': 'end', class: 'axis-label', fill: C.gold },
    [document.createTextNode(`Ziel ${fmt(a.goalWeight, 0)} kg`)]));

  // Plan (gestrichelt)
  const planPts = plan.map(p => [sx(dayNum(p.date)), sy(p.weight)]);
  if (planPts.length) svg.appendChild(el('path', { d: linePath(planPts), fill: 'none',
    stroke: C.ink3, 'stroke-width': 1.5, 'stroke-dasharray': '5 5', opacity: .8 }));

  // Trend-Fläche + Linie
  const trendPts = wser.filter(p => p.trend != null).map(p => [sx(dayNum(p.date)), sy(p.trend)]);
  if (trendPts.length > 1) {
    const areaId = 'wArea';
    const grad = el('linearGradient', { id: areaId, x1: 0, y1: 0, x2: 0, y2: 1 }, [
      el('stop', { offset: '0%', 'stop-color': C.gold, 'stop-opacity': .22 }),
      el('stop', { offset: '100%', 'stop-color': C.gold, 'stop-opacity': 0 }),
    ]);
    svg.appendChild(el('defs', {}, [grad]));
    const areaD = smoothPath(trendPts) + ` L${trendPts[trendPts.length - 1][0]},${h - pad.b} L${trendPts[0][0]},${h - pad.b} Z`;
    svg.appendChild(el('path', { d: areaD, fill: `url(#${areaId})` }));
    svg.appendChild(el('path', { d: smoothPath(trendPts), fill: 'none', stroke: C.gold, 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
  }

  // Rohpunkte
  for (const p of wser) if (p.weight != null)
    svg.appendChild(el('circle', { cx: sx(dayNum(p.date)), cy: sy(p.weight), r: 2.4, fill: C.weight, opacity: .8 }));

  // aktueller Trendpunkt betont
  const last = trendPts[trendPts.length - 1];
  if (last) {
    svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 6, fill: 'none', stroke: C.gold, 'stroke-width': 1, opacity: .4 }));
    svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 3.5, fill: C.gold, stroke: '#0A0C10', 'stroke-width': 1.5 }));
  }

  // Hover
  const tip = ensureTooltip(container);
  const cross = el('line', { y1: pad.t, y2: h - pad.b, stroke: C.line, 'stroke-width': 1, opacity: 0 });
  svg.appendChild(cross);
  attachHover(svg, container, tip, cross, wser.map(p => ({ x: sx(dayNum(p.date)), p })), (p) => `
    <div class="tooltip__date">${germanDate(p.date)}</div>
    <div class="tooltip__row"><span><span class="tooltip__sw" style="background:${C.gold}"></span>Trend</span><span>${fmt(p.trend)} kg</span></div>
    ${p.weight != null ? `<div class="tooltip__row"><span><span class="tooltip__sw" style="background:${C.weight}"></span>Messung</span><span>${fmt(p.weight)} kg</span></div>` : ''}
  `);

  container.appendChild(svg);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Körperkomposition: Fett / Muskel / Wasser
// ═══════════════════════════════════════════════════════════════════════════
export function renderCompositionChart(container, a) {
  container.querySelector('svg')?.remove();
  const { w, h } = dims(container, 240);
  const pad = { t: 16, r: 14, b: 26, l: 36 };
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
  const data = a.series.composition || [];
  if (!data.length) { container.appendChild(svg); return; }

  const series = [
    { key: 'fatPct', color: C.fat }, { key: 'musclePct', color: C.muscle }, { key: 'waterPct', color: C.water },
  ];
  const xs = data.map(p => dayNum(p.date));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const vals = data.flatMap(p => series.map(s => p[s.key])).filter(v => v != null);
  let ymin = Math.min(...vals), ymax = Math.max(...vals);
  const padY = (ymax - ymin) * 0.15 || 1; ymin -= padY; ymax += padY;
  const sx = scale(xmin, xmax, pad.l, w - pad.r);
  const sy = scale(ymin, ymax, h - pad.b, pad.t);

  for (const tk of niceTicks(ymin, ymax, 4)) {
    const y = sy(tk);
    svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, class: 'grid-line' }));
    svg.appendChild(el('text', { x: pad.l - 8, y: y + 3, 'text-anchor': 'end', class: 'axis-label' },
      [document.createTextNode(fmt(tk, 0))]));
  }
  const step = Math.max(1, Math.round((xmax - xmin) / 5));
  for (let d = xmin; d <= xmax; d += step) {
    const iso = new Date(d * 86400000).toISOString().slice(0, 10);
    svg.appendChild(el('text', { x: sx(d), y: h - pad.b + 16, 'text-anchor': 'middle', class: 'axis-label' },
      [document.createTextNode(shortDate(iso))]));
  }

  for (const s of series) {
    const pts = data.filter(p => p[s.key] != null).map(p => [sx(dayNum(p.date)), sy(p[s.key])]);
    if (pts.length > 1) svg.appendChild(el('path', { d: smoothPath(pts), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    const lastp = pts[pts.length - 1];
    if (lastp) svg.appendChild(el('circle', { cx: lastp[0], cy: lastp[1], r: 3, fill: s.color, stroke: '#0A0C10', 'stroke-width': 1.5 }));
  }

  const tip = ensureTooltip(container);
  const cross = el('line', { y1: pad.t, y2: h - pad.b, stroke: C.line, 'stroke-width': 1, opacity: 0 });
  svg.appendChild(cross);
  attachHover(svg, container, tip, cross, data.map(p => ({ x: sx(dayNum(p.date)), p })), (p) => `
    <div class="tooltip__date">${germanDate(p.date)}</div>
    <div class="tooltip__row"><span><span class="tooltip__sw" style="background:${C.fat}"></span>Fett</span><span>${fmt(p.fatPct)} %</span></div>
    <div class="tooltip__row"><span><span class="tooltip__sw" style="background:${C.muscle}"></span>Muskel</span><span>${fmt(p.musclePct)} %</span></div>
    <div class="tooltip__row"><span><span class="tooltip__sw" style="background:${C.water}"></span>Wasser</span><span>${fmt(p.waterPct)} %</span></div>
  `);
  container.appendChild(svg);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Kalorien-Timeline: wöchentliches Ziel
// ═══════════════════════════════════════════════════════════════════════════
export function renderCalorieChart(container, a) {
  container.querySelector('svg')?.remove();
  const { w, h } = dims(container, 240);
  const pad = { t: 18, r: 16, b: 26, l: 44 };
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
  const pts = (a.series.calorieTargets || []).filter(p => p.weekStart);
  if (pts.length < 1) { container.appendChild(svg); return; }

  const xs = pts.map(p => dayNum(p.weekStart));
  const xmin = Math.min(...xs), xmax = Math.max(...xs) + 0.001;
  const cs = pts.map(p => p.calories);
  let ymin = Math.min(...cs), ymax = Math.max(...cs);
  const padY = (ymax - ymin) * 0.35 || 120; ymin -= padY; ymax += padY;
  const sx = scale(xmin, xmax, pad.l, w - pad.r);
  const sy = scale(ymin, ymax, h - pad.b, pad.t);

  for (const tk of niceTicks(ymin, ymax, 4)) {
    const y = sy(tk);
    svg.appendChild(el('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, class: 'grid-line' }));
    svg.appendChild(el('text', { x: pad.l - 8, y: y + 3, 'text-anchor': 'end', class: 'axis-label' },
      [document.createTextNode(fmtInt(tk))]));
  }

  const P = pts.map(p => [sx(dayNum(p.weekStart)), sy(p.calories)]);
  // Stufenlinie (Ziel gilt jeweils bis zur nächsten Anpassung)
  let stepD = `M${P[0][0]},${P[0][1]}`;
  for (let i = 1; i < P.length; i++) stepD += ` L${P[i][0]},${P[i - 1][1]} L${P[i][0]},${P[i][1]}`;
  stepD += ` L${w - pad.r},${P[P.length - 1][1]}`;

  // Fläche
  const grad = el('linearGradient', { id: 'calArea', x1: 0, y1: 0, x2: 0, y2: 1 }, [
    el('stop', { offset: '0%', 'stop-color': C.gold, 'stop-opacity': .2 }),
    el('stop', { offset: '100%', 'stop-color': C.gold, 'stop-opacity': 0 }),
  ]);
  svg.appendChild(el('defs', {}, [grad]));
  svg.appendChild(el('path', { d: `${stepD} L${w - pad.r},${h - pad.b} L${P[0][0]},${h - pad.b} Z`, fill: 'url(#calArea)' }));
  svg.appendChild(el('path', { d: stepD, fill: 'none', stroke: C.gold, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));

  pts.forEach((p, i) => {
    svg.appendChild(el('circle', { cx: P[i][0], cy: P[i][1], r: i === pts.length - 1 ? 4 : 3,
      fill: i === pts.length - 1 ? C.gold : '#14181F', stroke: C.gold, 'stroke-width': 1.6 }));
    if (i === pts.length - 1 || i === 0)
      svg.appendChild(el('text', { x: P[i][0], y: P[i][1] - 10, 'text-anchor': 'middle', class: 'axis-label', fill: C.ink },
        [document.createTextNode(fmtInt(p.calories))]));
  });

  const tip = ensureTooltip(container);
  attachHover(svg, container, tip, null, pts.map((p, i) => ({ x: P[i][0], p })), (p) => `
    <div class="tooltip__date">ab ${germanDate(p.weekStart)}</div>
    <div class="tooltip__row"><span><span class="tooltip__sw" style="background:${C.gold}"></span>Ziel</span><span>${fmtInt(p.calories)} kcal</span></div>
    ${p.delta != null && p.delta !== 0 ? `<div class="tooltip__row"><span class="tooltip__k">Änderung</span><span>${p.delta > 0 ? '+' : ''}${p.delta} kcal</span></div>` : ''}
  `);
  container.appendChild(svg);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Kalibrier-Gauge: Ist-Tempo vs. Ziel-Tempo
// ═══════════════════════════════════════════════════════════════════════════
export function renderGauge(container, a) {
  container.innerHTML = '';
  const { w } = dims(container, 46);
  const h = 46;
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
  const dir = a.direction; // -1 abnehmen, +1 zunehmen
  const targetMag = Math.abs(a.targetRatePerWeek) || 0.5;
  const observed = a.observedRatePerWeek;
  const obsMag = observed == null ? null : observed * dir; // >0 = in Zielrichtung
  const dmax = Math.max(targetMag * 2, 0.4);
  const sx = scale(0, dmax, 8, w - 8);
  const trackY = 20;

  // Zonen: grün um das Ziel, sonst neutral
  svg.appendChild(el('rect', { x: 8, y: trackY - 4, width: w - 16, height: 8, rx: 4, fill: '#0E1117', stroke: C.line }));
  const gLo = sx(Math.max(0, targetMag * 0.8)), gHi = sx(Math.min(dmax, targetMag * 1.2));
  svg.appendChild(el('rect', { x: gLo, y: trackY - 4, width: Math.max(2, gHi - gLo), height: 8, rx: 4, fill: 'rgba(45,190,151,.35)' }));

  // Ziel-Tick
  const tx = sx(targetMag);
  svg.appendChild(el('line', { x1: tx, x2: tx, y1: trackY - 9, y2: trackY + 9, stroke: C.gold, 'stroke-width': 2 }));

  // Needle
  if (obsMag != null) {
    const nx = Math.max(8, Math.min(w - 8, sx(Math.max(0, obsMag))));
    const inZone = obsMag >= targetMag * 0.8 && obsMag <= targetMag * 1.2;
    const col = inZone ? C.muscle : (obsMag > targetMag ? C.gold : C.fat);
    svg.appendChild(el('line', { x1: nx, x2: nx, y1: trackY - 12, y2: trackY + 12, stroke: col, 'stroke-width': 2, opacity: .5 }));
    svg.appendChild(el('circle', { cx: nx, cy: trackY, r: 6, fill: col, stroke: '#0A0C10', 'stroke-width': 2 }));
    svg.appendChild(el('text', { x: nx, y: trackY + 26, 'text-anchor': 'middle', class: 'axis-label', fill: C.ink2 },
      [document.createTextNode(`${observed < 0 ? '−' : '+'}${fmt(Math.abs(observed), 2)} kg/W`)]));
  } else {
    svg.appendChild(el('text', { x: w / 2, y: trackY + 26, 'text-anchor': 'middle', class: 'axis-label', fill: C.ink3 },
      [document.createTextNode('noch keine Rate')]));
  }
  container.appendChild(svg);
}

// ── Sparkline (für Kacheln), gibt Markup zurück ─────────────────────────────
export function sparklineSVG(values, color, w = 78, h = 26) {
  const v = values.filter(x => x != null);
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v);
  const sx = scale(0, v.length - 1, 2, w - 2);
  const sy = scale(min, max, h - 3, 3);
  const pts = v.map((val, i) => [sx(i), sy(val)]);
  const d = smoothPath(pts);
  const area = `${d} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
  const gid = 'sp' + Math.abs(hash(color + w + v.length));
  return `<svg class="tile__spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="2.2" fill="${color}"/>
  </svg>`;
}

// ── Hover-Mechanik ──────────────────────────────────────────────────────────
function attachHover(svg, container, tip, cross, indexed, html) {
  if (!indexed.length) return;
  const overlay = el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'transparent', style: 'cursor:crosshair' });
  svg.appendChild(overlay);
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const mx = (ev.clientX - rect.left);
    let best = indexed[0], bd = Infinity;
    for (const it of indexed) { const d = Math.abs(it.x - mx); if (d < bd) { bd = d; best = it; } }
    if (cross) { cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x); cross.setAttribute('opacity', '1'); }
    tip.innerHTML = html(best.p);
    tip.style.left = best.x + 'px';
    tip.style.top = (ev.clientY - rect.top) + 'px';
    tip.style.opacity = '1';
  };
  const leave = () => { tip.style.opacity = '0'; if (cross) cross.setAttribute('opacity', '0'); };
  overlay.addEventListener('mousemove', move);
  overlay.addEventListener('mouseleave', leave);
  overlay.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
}

function germanDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
