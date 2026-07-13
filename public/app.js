// ─────────────────────────────────────────────────────────────────────────
//  app.js — lädt den Zustand, rendert das Dashboard, verdrahtet die Formulare.
// ─────────────────────────────────────────────────────────────────────────
import { renderWeightChart, renderCompositionChart, renderCalorieChart, renderGauge, sparklineSVG } from './charts.js';
import { MEAL_PLAN } from './mealplan.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let STATE = null;          // { backend, entries, config, analysis }
const PW_KEY = 'wc_pw';

const fmtInt = (v) => v == null ? '–' : Math.round(v).toLocaleString('de-DE');
const fmt1 = (v) => v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(1).replace('.', ',');
const fmt2 = (v) => v == null ? '–' : Number(v).toFixed(2).replace('.', ',');
const todayISO = () => new Date().toISOString().slice(0, 10);
const germanDate = (iso) => { if (!iso) return '–'; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };

// ── API ────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const pw = localStorage.getItem(PW_KEY);
  if (pw) headers['x-app-password'] = pw;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    const entered = prompt('Passwort für Weight Coach:');
    if (entered) { localStorage.setItem(PW_KEY, entered); return api(path, opts); }
    throw new Error('Nicht autorisiert');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Fehler ${res.status}`);
  return res.json();
}

async function loadState() {
  STATE = await api('/api/state');
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  const { analysis: a, config, backend } = STATE;
  $('#loader').hidden = true;
  $('#app').hidden = false;

  $('#backendPill').textContent = backend === 'sheets' ? '● Google Sheets' : '● Lokal (Demo)';
  $('#datePill').textContent = a.today ? germanDate(a.today.date) : germanDate(todayISO());
  $('#footKcalKg').textContent = fmtInt(config.kcalPerKg);

  renderHero(a);
  renderTiles(a);
  renderProgress(a);
  renderWeekTable(a);
  renderLegends();
  drawCharts();
}

function renderHero(a) {
  $('#heroWeekLabel').textContent = `Woche ${a.weeks.length + 1}`;
  countUp($('#heroKcal'), a.recommendedCalories);

  const d = a.calorieDelta;
  const chip = $('#heroDelta');
  chip.textContent = d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d)} kcal`;
  chip.dataset.dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';

  $('#heroRationale').textContent = a.rationale;

  const st = a.onSchedule.status;
  const stEl = $('#scheduleStatus');
  stEl.textContent = st === 'on' ? 'im Plan' : st === 'ahead' ? 'vor dem Plan' : 'leicht hinter Plan';
  stEl.dataset.s = st;

  $('#statMaintenance').textContent = a.maintenanceEstimate ? `${fmtInt(a.maintenanceEstimate)}` : '–';
  if (a.etaDate) {
    const dt = new Date(a.etaDate + 'T00:00:00');
    $('#statEta').textContent = dt.toLocaleDateString('de-DE', { month: 'short', year: 'numeric' });
    $('#statEta').title = a.etaWeeks ? `in ~${fmt1(a.etaWeeks)} Wochen (${germanDate(a.etaDate)})` : '';
  } else {
    $('#statEta').textContent = '–';
  }
}

function renderTiles(a) {
  const comp = a.series.composition || [];
  const wtrend = (a.series.weight || []).map(p => p.trend);
  const dir = a.direction;
  const tiles = [
    { key: 'weight', label: 'Trendgewicht', unit: 'kg', color: 'var(--gold)', desired: dir, spark: wtrend, val: a.metrics.weight.current, delta: a.metrics.weight.delta7 },
    { key: 'fatPct', label: 'Körperfett', unit: '%', color: 'var(--rose)', desired: -1, spark: comp.map(p => p.fatPct), val: a.metrics.fatPct.current, delta: a.metrics.fatPct.delta7 },
    { key: 'musclePct', label: 'Muskelmasse', unit: '%', color: 'var(--green)', desired: 1, spark: comp.map(p => p.musclePct), val: a.metrics.musclePct.current, delta: a.metrics.musclePct.delta7 },
    { key: 'waterPct', label: 'Körperwasser', unit: '%', color: 'var(--blue)', desired: 0, spark: comp.map(p => p.waterPct), val: a.metrics.waterPct.current, delta: a.metrics.waterPct.delta7 },
  ];
  const sparkColors = { weight: '#F2B138', fatPct: '#F5637E', musclePct: '#2DBE97', waterPct: '#7AA2F7' };
  $('#tiles').innerHTML = tiles.map(t => {
    let dir3 = 'flat';
    if (t.delta != null && t.desired !== 0 && Math.abs(t.delta) > 0.05)
      dir3 = Math.sign(t.delta) === Math.sign(t.desired) ? 'good' : 'bad';
    const arrow = t.delta == null ? '' : t.delta > 0.05 ? '▲' : t.delta < -0.05 ? '▼' : '■';
    const deltaTxt = t.delta == null ? '–' : `${arrow} ${t.delta > 0 ? '+' : t.delta < 0 ? '−' : ''}${fmt1(Math.abs(t.delta))} ${t.unit}`;
    return `<article class="tile" style="--tile-c:${t.color}">
      <div class="tile__label"><span class="tile__dot"></span>${t.label}</div>
      <div class="tile__value">${fmt1(t.val)}<span class="tile__unit">${t.unit}</span></div>
      <div class="tile__foot">
        <span class="tile__delta" data-dir="${dir3}" title="Veränderung über 7 Tage">${deltaTxt}</span>
        ${sparklineSVG(t.spark, sparkColors[t.key])}
      </div>
    </article>`;
  }).join('');
}

function renderProgress(a) {
  $('#progStart').textContent = fmt1(a.startWeight) + ' kg';
  $('#progGoal').textContent = fmt1(a.goalWeight) + ' kg';
  $('#progNow').textContent = a.trendWeight != null ? `jetzt ${fmt1(a.trendWeight)} kg` : '–';
  const toGo = a.totalToGo == null ? null : Math.abs(a.totalToGo);
  $('#progToGo').textContent = toGo != null ? `noch ${fmt1(toGo)} kg` : '';
  requestAnimationFrame(() => {
    $('#progFill').style.width = a.progressPct + '%';
    $('#progDot').style.left = a.progressPct + '%';
  });
}

function renderWeekTable(a) {
  const body = $('#weekTableBody');
  if (!a.weeks.length) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--ink-3);padding:1.4rem">Nach deiner ersten vollen Woche erscheint hier die Auswertung.</td></tr>`;
    return;
  }
  body.innerHTML = [...a.weeks].reverse().map(w => {
    const dcls = w.calorieDelta > 0 ? 'chip--up' : w.calorieDelta < 0 ? 'chip--down' : 'chip--flat';
    const dtxt = w.calorieDelta === 0 ? '±0' : `${w.calorieDelta > 0 ? '+' : '−'}${Math.abs(w.calorieDelta)}`;
    const rate = `${w.observedRate < 0 ? '−' : '+'}${fmt2(Math.abs(w.observedRate))}`;
    const why = w.hold === 'adaptation'
      ? `Anlaufphase: ${fmt2(w.waterKg)} kg der Abnahme als Wasser/Glykogen verbucht – Ziel bewusst gehalten`
      : w.hold === 'tolerance' ? 'Abweichung im Toleranzband – Ziel gehalten'
      : w.tooFast ? 'Abnahme zu schnell – Ziel angehoben' : '';
    return `<tr>
      <td class="wk">${w.index}</td>
      <td>${germanDate(w.weekStart).slice(0, 6)}–${germanDate(w.weekEnd).slice(0, 6)}</td>
      <td class="num">${fmt1(w.trendEnd)} kg</td>
      <td class="num">${rate} kg/W</td>
      <td class="num">${fmtInt(w.maintenanceSmoothed)}</td>
      <td class="num">${fmtInt(w.targetCalories)}</td>
      <td class="num"><span class="chip ${dcls}"${why ? ` title="${why}"` : ''}>${dtxt}</span></td>
    </tr>`;
  }).join('');
}

function renderLegends() {
  $('#weightLegend').innerHTML = legend([
    ['var(--gold)', 'Trend', false], ['var(--s-weight)', 'Messung', false],
    ['var(--ink-3)', 'Plan', true],
  ]);
  $('#compLegend').innerHTML = legend([
    ['var(--rose)', 'Fett', false], ['var(--green)', 'Muskel', false], ['var(--blue)', 'Wasser', false],
  ]);
  $('#calLegend').innerHTML = legend([['var(--gold)', 'Ziel-kcal', false]]);
}
const legend = (items) => items.map(([c, label, dash]) =>
  `<span class="legend__item"><span class="legend__swatch ${dash ? 'legend__swatch--dash' : ''}" style="${dash ? 'color:' + c : 'background:' + c}"></span>${label}</span>`).join('');

// ── Charts (mit Resize) ──────────────────────────────────────────────────────
function drawCharts() {
  if (!STATE) return;
  const a = STATE.analysis;
  renderWeightChart($('#weightChart'), a);
  renderCompositionChart($('#compChart'), a);
  renderCalorieChart($('#calChart'), a);
  renderGauge($('#gauge'), a);
}
let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(drawCharts, 150); });

// ── Zahlen-Animation ─────────────────────────────────────────────────────────
function countUp(node, target) {
  if (target == null) { node.textContent = '––––'; return; }
  const from = Number((node.textContent || '0').replace(/\D/g, '')) || 0;
  if (reduceMotion || from === target) { node.textContent = fmtInt(target); return; }
  const dur = 650, t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    node.textContent = fmtInt(Math.round(from + (target - from) * e));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Modals ───────────────────────────────────────────────────────────────────
function openModal(id) {
  const m = $('#' + id); m.hidden = false;
  m.querySelector('input,button,select,textarea')?.focus();
}
function closeModal(m) { m.hidden = true; }
$$('.modal [data-close]').forEach(b => b.addEventListener('click', (e) => closeModal(e.target.closest('.modal'))));
addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal').forEach(m => { if (!m.hidden) closeModal(m); }); });

// Eintrag
$('#openEntry').addEventListener('click', () => {
  const f = $('#entryForm');
  f.reset();
  $('#entryDate').value = todayISO();
  prefillEntry(todayISO());
  openModal('entryModal');
});
$('#entryDate').addEventListener('change', (e) => prefillEntry(e.target.value));

function prefillEntry(date) {
  const existing = STATE?.entries.find(e => e.date === date);
  const f = $('#entryForm');
  for (const k of ['weight', 'musclePct', 'fatPct', 'waterPct', 'calories']) {
    f.elements[k].value = existing && existing[k] != null ? String(existing[k]).replace('.', ',') : '';
  }
}

$('#entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    date: f.elements.date.value,
    weight: f.elements.weight.value, musclePct: f.elements.musclePct.value,
    fatPct: f.elements.fatPct.value, waterPct: f.elements.waterPct.value,
    calories: f.elements.calories.value,
  };
  try {
    STATE = await api('/api/entries', { method: 'POST', body: JSON.stringify(body) });
    closeModal($('#entryModal'));
    render();
    toast('Messung gespeichert ✓');
  } catch (err) { toast(err.message, true); }
});

// Einstellungen
$('#openSettings').addEventListener('click', () => {
  const c = STATE.config, f = $('#settingsForm');
  for (const k of Object.keys(c)) if (f.elements[k]) f.elements[k].value = c[k] ?? '';
  // Startgewicht wird abgeleitet: aktuellen (aus 1. Eintrag ermittelten) Wert zeigen.
  if (f.elements.startWeight) f.elements.startWeight.value = STATE.analysis.startWeight ?? c.startWeight ?? '';
  openModal('settingsModal');
});
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, body = {};
  for (const inp of $$('input', f)) if (inp.name) body[inp.name] = inp.value;
  try {
    STATE = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    closeModal($('#settingsModal'));
    render();
    toast('Einstellungen gespeichert ✓');
  } catch (err) { toast(err.message, true); }
});

// ── Essensplan ───────────────────────────────────────────────────────────────
function renderPlan() {
  const planKcal = STATE?.config?.planCalories ?? MEAL_PLAN.totalKcal;
  $('#planTotalKcal').textContent = fmtInt(MEAL_PLAN.totalKcal);
  $('#planTotalProt').textContent = (MEAL_PLAN.proteinApprox ? '~' : '') + MEAL_PLAN.totalProtein;
  $('#planMeta').textContent = MEAL_PLAN.meta;
  $('#planMeals').innerHTML = MEAL_PLAN.meals.map((m) => `
    <article class="meal">
      <div class="meal__head">
        <span class="meal__icon">${m.icon}</span>
        <span class="meal__name">${escapeHtml(m.name)}</span>
        <span class="meal__macros"><b>${fmtInt(m.kcal)}</b> kcal</span>
      </div>
      <ul class="meal__items">${m.items.map((i) =>
        `<li><span>${escapeHtml(i.n)}</span><span class="meal__ik">${fmtInt(i.kcal)}</span></li>`).join('')}</ul>
    </article>`).join('')
    + (MEAL_PLAN.extras ? `<p class="plan__extras">${escapeHtml(MEAL_PLAN.extras)}</p>` : '');
  $('#logPlan').textContent = `Heute als gegessen loggen · ${fmtInt(planKcal)} kcal`;
}

$('#openPlan').addEventListener('click', () => { renderPlan(); openModal('planModal'); });

$('#logPlan').addEventListener('click', async () => {
  const date = todayISO();
  // bestehenden Tageswert bewahren – nur die Kalorien setzen (Gewicht bleibt).
  const existing = STATE.entries.find((e) => e.date === date) || { date };
  const kcal = STATE.config.planCalories ?? MEAL_PLAN.totalKcal;
  try {
    STATE = await api('/api/entries', { method: 'POST', body: JSON.stringify({ ...existing, date, calories: kcal }) });
    closeModal($('#planModal'));
    render();
    toast(`Plan geloggt · ${fmtInt(kcal)} kcal ✓`);
  } catch (err) { toast(err.message, true); }
});

// ── KI-Coach ─────────────────────────────────────────────────────────────────
$('#askCoach').addEventListener('click', runCoach);

async function runCoach() {
  openModal('coachModal');
  $('#coachBody').innerHTML = `<div class="coach__loading"><div class="loader__ring"></div><p>Analysiere deine Woche &amp; deinen Plan …</p></div>`;
  try {
    const advice = await api('/api/coach', { method: 'POST', body: JSON.stringify({ mealPlan: MEAL_PLAN }) });
    renderCoachResult(advice);
  } catch (err) {
    const isKey = /ANTHROPIC_API_KEY/i.test(err.message);
    $('#coachBody').innerHTML = `<div class="coach__error">
      <p>${escapeHtml(err.message)}</p>
      ${isKey ? `<p class="form__hint">Hinterlege deinen Anthropic-API-Schlüssel als Umgebungsvariable <code>ANTHROPIC_API_KEY</code> – lokal in <code>.env</code>, online in den Vercel-Projekteinstellungen.</p>` : ''}
    </div>`;
  }
}

function renderCoachResult(a) {
  const V = {
    on_track: { t: 'Auf Kurs', c: 'blue' },
    eat_more: { t: 'Etwas mehr essen', c: 'green' },
    eat_less: { t: 'Etwas weniger essen', c: 'rose' },
  }[a.verdict] || { t: 'Auf Kurs', c: 'blue' };
  const cur = STATE.config.planCalories ?? MEAL_PLAN.totalKcal;
  const changed = a.newPlanCalories && a.newPlanCalories !== cur;
  const adj = (a.adjustments || []).map((x) =>
    `<li><span>${escapeHtml(x.change)}</span><span class="coach__delta ${x.deltaKcal < 0 ? 'neg' : x.deltaKcal > 0 ? 'pos' : ''}">${x.deltaKcal > 0 ? '+' : ''}${x.deltaKcal} kcal</span></li>`).join('');

  $('#coachBody').innerHTML = `
    <div class="coach__verdict coach__verdict--${V.c}">${V.t}</div>
    <p class="coach__assessment">${escapeHtml(a.assessment)}</p>
    ${adj ? `<div class="coach__section"><span class="eyebrow">Vorgeschlagene Anpassungen</span><ul class="coach__adjust">${adj}</ul></div>` : ''}
    <div class="coach__target">
      <div><span class="eyebrow">Neues Tagesziel</span><span class="coach__kcal">${fmtInt(a.newPlanCalories)} kcal</span></div>
      ${changed ? `<button class="btn btn--primary" id="applyCoach">Übernehmen</button>` : `<span class="coach__ok">bereits gesetzt ✓</span>`}
    </div>
    ${a.summary ? `<p class="coach__summary">${escapeHtml(a.summary)}</p>` : ''}
    <p class="coach__model">erzeugt mit ${escapeHtml(a.model || 'Claude')}</p>`;

  if (changed) $('#applyCoach').addEventListener('click', async () => {
    try {
      STATE = await api('/api/config', { method: 'PUT', body: JSON.stringify({ planCalories: a.newPlanCalories }) });
      render();
      closeModal($('#coachModal'));
      toast(`Neues Tagesziel: ${fmtInt(a.newPlanCalories)} kcal ✓`);
    } catch (e) { toast(e.message, true); }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Toast ────────────────────────────────────────────────────────────────────
let toastT;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.className = 'toast' + (isErr ? ' toast--err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}

// ── Start ────────────────────────────────────────────────────────────────────
loadState().catch(err => {
  $('#loader').innerHTML = `<p style="color:var(--rose)">Konnte nicht laden: ${err.message}</p>`;
});
