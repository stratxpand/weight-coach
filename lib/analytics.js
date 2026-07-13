// ─────────────────────────────────────────────────────────────────────────
//  analytics.js — Die adaptive Kalorien-Engine
//
//  Grundidee (adaptives TDEE / "Maintenance-Tracking"):
//   1. Tägliche Gewichte schwanken stark (Wasser, Darminhalt, Salz …).
//      Deshalb glätten wir mit einer gleitenden linearen Regression auf einem
//      täglich interpolierten Raster → "Trendgewicht". Die Regression läuft dem
//      echten Verlauf – anders als ein EMA – nicht hinterher.
//   2. Aus der tatsächlichen Trend-Veränderung pro Woche und der
//      (gegessenen oder vorgegebenen) Kalorienmenge schätzen wir deinen
//      echten Erhaltungsbedarf:  Erhaltung = Aufnahme − Δkg·kcalPerKg/7
//   3. Diese Schätzung wird über die Wochen gedämpft (EMA über Wochen),
//      damit eine einzelne gute/schlechte Woche das Bild nicht kippt
//      ("das Gesamtbild zählt").
//   4. Für die kommende Woche geben wir vor:
//         Ziel-kcal = Erhaltung + Ziel-Energiebilanz
//      wobei die Ziel-Rate leicht nachjustiert wird, um einen Rückstand
//      auf deinen geplanten Verlauf über mehrere Wochen sanft aufzuholen.
//   5. Die Änderung pro Woche wird gedeckelt (maxWeeklyAdjust) und mit
//      einer kcal-Untergrenze abgesichert.
//
//  Alle Parameter sind in DEFAULT_CONFIG dokumentiert und überschreibbar.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  startWeight: 100,        // kg – Fallback, solange kein Eintrag existiert; sonst wird
                           //      das Startgewicht automatisch aus dem 1. Eintrag abgeleitet

  goalWeight: 90,          // kg – Zielgewicht
  startDate: null,         // ISO-Datum (YYYY-MM-DD); wird beim 1. Eintrag gesetzt
  weeklyRate: 0.5,         // kg/Woche – gewünschtes Tempo (Betrag). Richtung ergibt sich aus start↔goal
  startCalories: 2200,     // kcal/Tag – Ausgangs-Kalorienziel
  kcalPerKg: 7700,         // kcal – Energiegehalt pro kg Körpermasse (Faustwert)
  trendWindowDays: 14,     // Tage – Glättungsfenster des Trendgewichts (größer = ruhiger)
  updateCadenceDays: 7,    // Tage – Rhythmus der Kalorien-Anpassung
  dampening: 0.5,          // 0..1 – Gewicht der aktuellsten Woche in der Erhaltungs-Schätzung
  maxWeeklyAdjust: 250,    // kcal – maximale Änderung des Ziels pro Anpassung
  catchUpWeeks: 4,         // über wie viele Wochen ein Trajektorien-Rückstand aufgeholt wird
  maxRate: 1.0,            // kg/Woche – Sicherheits-Obergrenze für die effektive Rate
  minCalories: 1400,       // kcal – Untergrenze des Ziels (Sicherheit)
  planCalories: 2188,      // kcal – Tages-Kalorien deines Essensplans (für "Plan gegessen")

  // ── Anlaufphase & Toleranz ────────────────────────────────────────────
  // Zu Beginn einer Diät verliert man neben Fett vor allem Wasser und
  // Glykogen. Diese Extra-Abnahme ist KEINE Energiebilanz – würde man sie
  // als solche verrechnen, käme ein viel zu hoher Erhaltungsbedarf heraus
  // und das Kalorienziel würde sofort nach oben korrigiert. Deshalb:
  adaptationWeeks: 3,      // Wochen – Anlaufphase, in der Extra-Abnahme als Wasser gilt
  waterAllowanceKg: 1.2,   // kg – wie viel Extra-Abnahme in Woche 1 höchstens als Wasser
                           //      verbucht wird; halbiert sich mit jeder weiteren Woche
                           //      (Woche 2: 0,6 kg, Woche 3: 0,3 kg, danach 0)

  rateTolerance: 0.35,     // kg/Woche – Toleranzband um die Ziel-Rate. Solange die Abweichung
                           //      darunter liegt, bleibt das Kalorienziel unverändert
                           //      (Ziel 0,5 → alles zwischen 0,15 und 0,85 kg/Wo ist "in Ordnung")
  fastLossLimit: 1.5,      // kg/Woche – erst ab dieser Rate gilt die Abnahme als "zu schnell";
                           //      dann wird immer gegengesteuert, auch in der Anlaufphase
};

const DAY = 86400000;

// ── kleine Helfer ────────────────────────────────────────────────────────
const toDayNum = (iso) => Math.floor(new Date(iso + 'T00:00:00Z').getTime() / DAY);
const dayNumToISO = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round = (v) => Math.round(v);

// Interpoliert eine Metrik (nur vorhandene Werte) auf ein tägliches Raster
// von dayFrom..dayTo und liefert ein Array gleicher Länge zurück.
function dailyInterpolate(points, dayFrom, dayTo) {
  const known = points
    .filter((p) => p.v != null && !Number.isNaN(p.v))
    .sort((a, b) => a.t - b.t);
  const out = [];
  if (known.length === 0) return out;
  for (let d = dayFrom; d <= dayTo; d++) {
    if (d <= known[0].t) { out.push(known[0].v); continue; }
    if (d >= known[known.length - 1].t) { out.push(known[known.length - 1].v); continue; }
    // finde umschließende Punkte
    let i = 0;
    while (i < known.length - 1 && known[i + 1].t < d) i++;
    const a = known[i], b = known[i + 1];
    const f = (d - a.t) / (b.t - a.t);
    out.push(a.v + f * (b.v - a.v));
  }
  return out;
}

// Nachlauffreier Trend: für jeden Tag eine gleitende lineare Regression über
// das trailing-Fenster, ausgewertet am Fenster-Ende. Im Gegensatz zum EMA
// „hängt" dieser Trend bei stetigem Ab-/Zunehmen nicht hinterher – der aktuelle
// Rand schätzt Gewicht UND Steigung unverzerrt.
function rollingRegression(values, windowDays) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - windowDays + 1);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = lo; j <= i; j++) { const x = j, y = values[j]; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    if (n < 2) { out.push(values[i]); continue; }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    out.push(intercept + slope * i);
  }
  return out;
}

// ── Hauptfunktion ────────────────────────────────────────────────────────
export function analyze(rawEntries, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  // Einträge normalisieren, pro Datum nur den letzten behalten, sortieren.
  const byDate = new Map();
  for (const e of rawEntries || []) {
    if (!e || !e.date) continue;
    byDate.set(e.date, {
      date: e.date,
      weight: numOrNull(e.weight),
      fatPct: numOrNull(e.fatPct),
      musclePct: numOrNull(e.musclePct),
      waterPct: numOrNull(e.waterPct),
      calories: numOrNull(e.calories), // optional: tatsächlich gegessen
    });
  }
  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const empty = baseResult(cfg);
  if (entries.length === 0) return empty;

  const firstDay = toDayNum(entries[0].date);
  const lastDay = toDayNum(entries[entries.length - 1].date);
  const startDay = cfg.startDate ? toDayNum(cfg.startDate) : firstDay;

  // Startgewicht wird aus dem ersten gemessenen Gewicht abgeleitet – nicht aus
  // der Config. cfgS ist die effektive Konfiguration für alle Plan-Rechnungen.
  const firstWeighed = entries.find((e) => e.weight != null);
  const startWeight = firstWeighed ? firstWeighed.weight : cfg.startWeight;
  const cfgS = { ...cfg, startWeight };

  // Richtung: -1 = abnehmen (Defizit), +1 = zunehmen (Überschuss)
  const direction = cfg.goalWeight < startWeight ? -1 : 1;
  const targetChangePerWeek = direction * Math.abs(cfg.weeklyRate); // signiert (kg/Woche)

  // Tägliche, geglättete Serien aufbauen.
  const wPoints = entries.map((e) => ({ t: toDayNum(e.date), v: e.weight }));
  const gridFrom = firstDay, gridTo = lastDay;
  const weightDaily = dailyInterpolate(wPoints, gridFrom, gridTo);
  const weightTrend = rollingRegression(weightDaily, cfg.trendWindowDays);

  const trendAt = (dayNum) => {
    const idx = clamp(dayNum - gridFrom, 0, weightTrend.length - 1);
    return weightTrend.length ? weightTrend[idx] : null;
  };

  const trendWeight = weightTrend[weightTrend.length - 1];
  const latest = entries[entries.length - 1];

  // Aktuelle Momentum-Rate: Trend heute vs. Trend vor 7 Tagen (kg/Woche, signiert).
  let observedRatePerWeek = null;
  const spanDays = lastDay - firstDay;
  if (spanDays >= 5) {
    const back = Math.min(7, spanDays);
    const now = weightTrend[weightTrend.length - 1];
    const then = weightTrend[weightTrend.length - 1 - back];
    observedRatePerWeek = (now - then) * (7 / back);
  }

  // ── Wochenweise Anpassung durchrechnen ────────────────────────────────
  // Wir laufen in updateCadenceDays-Schritten ab startDay bis zur letzten
  // abgeschlossenen Periode und tragen Ziel-kcal + gedämpfte Erhaltung mit.
  const cadence = cfg.updateCadenceDays;
  const weeks = [];
  let currentTarget = cfg.startCalories;
  let prevTarget = cfg.startCalories;
  let maintEMA = null;

  // Anzahl abgeschlossener Perioden seit startDay
  const periods = Math.floor((lastDay - startDay) / cadence);

  for (let p = 0; p < periods; p++) {
    const wStart = startDay + p * cadence;
    const wEnd = wStart + cadence;
    if (wEnd > lastDay) break;

    const trendStart = trendAt(wStart);
    const trendEnd = trendAt(wEnd);
    if (trendStart == null || trendEnd == null) continue;

    const observedChange = trendEnd - trendStart;            // kg über die Periode (signiert)
    const observedRate = observedChange * (7 / cadence);     // kg/Woche

    // Aufnahme dieser Periode: tatsächlich geloggt (Mittel) sonst das damals gültige Ziel.
    const loggedAvg = avgCalories(entries, wStart, wEnd);
    const intake = loggedAvg != null ? loggedAvg : currentTarget;

    // Wasser-/Glykogen-Korrektur: In der Anlaufphase wird der Teil der Abnahme, der
    // ÜBER dem Plan liegt, bis zur Freimenge nicht als Energie verbucht. Damit wird der
    // Erhaltungsbedarf nicht künstlich hochgerechnet (Kern des Anfangs-Effekts).
    const plannedChange = targetChangePerWeek * (cadence / 7);   // kg, signiert
    const excess = Math.max(0, Math.abs(observedChange) - Math.abs(plannedChange));
    const waterKg = Math.min(excess, waterAllowance(cfg, p));    // kg, ≥ 0
    const energyChange = observedChange - direction * waterKg;   // Betrag um waterKg entschärft

    // Erhaltungsbedarf-Schätzung dieser Woche (auf Basis der energetischen Änderung).
    const maint = intake - (energyChange * cfg.kcalPerKg) / cadence;

    // Dämpfen: gleitender Mittelwert über die Wochen → "Gesamtbild".
    maintEMA = maintEMA == null ? maint : cfg.dampening * maint + (1 - cfg.dampening) * maintEMA;

    // Effektive Ziel-Rate mit sanftem Trajektorien-Ausgleich.
    const weeksElapsed = (wEnd - startDay) / 7;
    const planned = plannedWeight(cfgS, targetChangePerWeek, weeksElapsed);
    const scheduleError = trendEnd - planned;                // >0 = hinter Plan (bei Abnahme: zu schwer)
    const catchUp = -scheduleError / cfg.catchUpWeeks;       // signierte Rate-Korrektur
    let effRate = targetChangePerWeek + catchUp;
    // Auf sinnvollen Bereich begrenzen: nie die Richtung umkehren, nie zu schnell.
    effRate = direction < 0
      ? clamp(effRate, -Math.abs(cfg.maxRate), 0)
      : clamp(effRate, 0, Math.abs(cfg.maxRate));

    // Neues Ziel = gedämpfte Erhaltung + Ziel-Energiebilanz.
    const targetDailyBalance = (effRate * cfg.kcalPerKg) / 7; // <0 = Defizit
    let newTarget = maintEMA + targetDailyBalance;

    // Änderung pro Woche deckeln + Untergrenze.
    newTarget = clamp(newTarget, currentTarget - cfg.maxWeeklyAdjust, currentTarget + cfg.maxWeeklyAdjust);
    newTarget = Math.max(newTarget, cfg.minCalories);

    // ── Wann wird überhaupt angepasst? ──────────────────────────────────
    // 1. "zu schnell" (jenseits fastLossLimit) → immer gegensteuern, auch in Woche 1.
    // 2. Abweichung innerhalb des Toleranzbands → Ziel halten.
    // 3. In der Anlaufphase schneller als geplant → Ziel halten (das ist Wasser,
    //    kein Grund, das Defizit zu verkleinern; der Effekt läuft von selbst aus).
    const tooFast = Math.abs(observedRate) >= cfg.fastLossLimit && observedRate * direction > 0;
    const rateError = observedRate - targetChangePerWeek;      // signiert
    const fasterThanPlan = rateError * direction > 0;          // schneller als geplant unterwegs
    let hold = null;
    if (!tooFast) {
      if (Math.abs(rateError) <= cfg.rateTolerance) hold = 'tolerance';
      else if (fasterThanPlan && p < cfg.adaptationWeeks) hold = 'adaptation';
    }
    if (hold) newTarget = currentTarget;

    prevTarget = currentTarget;
    currentTarget = newTarget;

    weeks.push({
      index: p + 1,
      weekStart: dayNumToISO(wStart),
      weekEnd: dayNumToISO(wEnd),
      trendStart: round1(trendStart),
      trendEnd: round1(trendEnd),
      observedRate: round2(observedRate),
      intake: round(intake),
      loggedIntake: loggedAvg != null,
      waterKg: round2(waterKg),
      maintenance: round(maint),
      maintenanceSmoothed: round(maintEMA),
      plannedWeight: round1(planned),
      scheduleError: round1(scheduleError),
      effRate: round2(effRate),
      targetCalories: round(newTarget),
      calorieDelta: round(newTarget - prevTarget),
      hold,
      tooFast,
    });
  }

  // Kopf-Rate = die zuletzt abgeschlossene Woche (die die Empfehlung ausgelöst
  // hat). So beziehen sich Empfehlung, Begründung und Gauge auf dieselbe Woche;
  // vor der ersten vollen Woche bleibt es die trailing-7-Tage-Momentum-Rate.
  if (weeks.length) observedRatePerWeek = weeks[weeks.length - 1].observedRate;

  // ── Kopfzahlen ────────────────────────────────────────────────────────
  const recommendedCalories = round(currentTarget);
  const previousCalories = round(prevTarget);
  const maintenanceEstimate = maintEMA != null ? round(maintEMA) : null;

  const weeksElapsedNow = Math.max(0, (lastDay - startDay) / 7);
  const plannedNow = plannedWeight(cfgS, targetChangePerWeek, weeksElapsedNow);
  const scheduleErrorNow = trendWeight - plannedNow;
  const onScheduleStatus =
    Math.abs(scheduleErrorNow) < 0.4 ? 'on' : (scheduleErrorNow * direction > 0 ? 'ahead' : 'behind');
  // Erklärung: bei Abnahme (direction -1) heißt scheduleError<0 (leichter als Plan) = "ahead".

  const totalToGo = cfg.goalWeight - trendWeight;              // signiert
  const totalSpan = cfg.goalWeight - startWeight || 1;
  const progressPct = clamp(((trendWeight - startWeight) / totalSpan) * 100, 0, 100);

  // ETA: mit welcher effektiven Rate nähern wir uns aktuell dem Ziel?
  let etaDate = null, etaWeeks = null;
  const rateForEta = observedRatePerWeek != null && observedRatePerWeek * direction > 0
    ? observedRatePerWeek
    : targetChangePerWeek;
  if (Math.abs(rateForEta) > 1e-6 && totalToGo * direction > 0) {
    etaWeeks = totalToGo / rateForEta;
    if (etaWeeks > 0 && Number.isFinite(etaWeeks)) {
      etaDate = dayNumToISO(lastDay + Math.round(etaWeeks * 7));
    }
  }

  const hasEnoughData = weeks.length >= 1;
  const lastWeek = weeks.length ? weeks[weeks.length - 1] : null;

  // Wie steht die letzte Woche zur Anpassungs-Logik? (für UI + KI-Coach)
  const adjustment = {
    hold: lastWeek?.hold ?? null,               // 'tolerance' | 'adaptation' | null
    tooFast: lastWeek?.tooFast ?? false,
    inAdaptation: weeks.length < cfg.adaptationWeeks,
    rateTolerance: cfg.rateTolerance,
    fastLossLimit: cfg.fastLossLimit,
    waterKg: lastWeek?.waterKg ?? 0,
  };

  return {
    hasEnoughData,
    adjustment,
    generatedFor: latest.date,
    direction,
    config: cfg,

    today: {
      date: latest.date,
      weight: latest.weight,
      fatPct: latest.fatPct,
      musclePct: latest.musclePct,
      waterPct: latest.waterPct,
      calories: latest.calories,
    },

    trendWeight: round1(trendWeight),
    startWeight: round1(startWeight),
    goalWeight: cfg.goalWeight,
    totalToGo: round1(totalToGo),
    progressPct: Math.round(progressPct),

    observedRatePerWeek: observedRatePerWeek != null ? round2(observedRatePerWeek) : null,
    targetRatePerWeek: round2(targetChangePerWeek),

    maintenanceEstimate,
    recommendedCalories,
    previousCalories,
    calorieDelta: recommendedCalories - previousCalories,

    onSchedule: {
      plannedWeightNow: round1(plannedNow),
      scheduleErrorKg: round1(scheduleErrorNow),
      status: onScheduleStatus,
    },
    etaDate,
    etaWeeks: etaWeeks != null ? round1(etaWeeks) : null,
    weeksElapsed: round1(weeksElapsedNow),

    rationale: buildRationale({
      hasEnoughData, direction, observedRatePerWeek, targetChangePerWeek,
      calorieDelta: recommendedCalories - previousCalories, recommendedCalories,
      onScheduleStatus, weeksNeeded: weeks.length, adjustment,
    }),

    metrics: {
      weight: metricSummary(entries, 'weight', cfg.trendWindowDays, gridFrom, gridTo),
      fatPct: metricSummary(entries, 'fatPct', 7, gridFrom, gridTo),
      musclePct: metricSummary(entries, 'musclePct', 7, gridFrom, gridTo),
      waterPct: metricSummary(entries, 'waterPct', 7, gridFrom, gridTo),
    },

    weeks,

    series: {
      weight: entries.map((e) => ({
        date: e.date,
        weight: e.weight,
        trend: round1(trendAt(toDayNum(e.date))),
      })),
      plan: buildPlanSeries(cfgS, targetChangePerWeek, startDay, lastDay),
      composition: entries.map((e) => ({
        date: e.date, fatPct: e.fatPct, musclePct: e.musclePct, waterPct: e.waterPct,
      })),
      calorieTargets: buildCalorieSeries(cfg, weeks),
    },
  };
}

// ── Unterstützende Berechnungen ──────────────────────────────────────────
// Freimenge für Wasser-/Glykogen-Verlust in Periode p (0-basiert): startet bei
// waterAllowanceKg und halbiert sich pro Woche, nach adaptationWeeks ist sie 0.
function waterAllowance(cfg, p) {
  if (p >= cfg.adaptationWeeks) return 0;
  return cfg.waterAllowanceKg * Math.pow(0.5, p);
}

function plannedWeight(cfg, targetChangePerWeek, weeksElapsed) {
  const raw = cfg.startWeight + targetChangePerWeek * weeksElapsed;
  // nicht über das Ziel hinaus planen
  return targetChangePerWeek < 0 ? Math.max(raw, cfg.goalWeight) : Math.min(raw, cfg.goalWeight);
}

function buildPlanSeries(cfg, targetChangePerWeek, startDay, lastDay) {
  // geplante Trajektorie von Start bis zum Zieldatum (oder Datenende, je nachdem was später)
  const weeksToGoal = Math.abs((cfg.goalWeight - cfg.startWeight) / (targetChangePerWeek || 1));
  const goalDay = startDay + Math.ceil(weeksToGoal * 7);
  const endDay = Math.max(lastDay, goalDay);
  const pts = [];
  for (let d = startDay; d <= endDay; d += 7) {
    const w = plannedWeight(cfg, targetChangePerWeek, (d - startDay) / 7);
    pts.push({ date: dayNumToISO(d), weight: round1(w) });
  }
  // exaktes Zieldatum als letzten Punkt sicherstellen
  const gw = plannedWeight(cfg, targetChangePerWeek, weeksToGoal);
  pts.push({ date: dayNumToISO(goalDay), weight: round1(gw) });
  return pts;
}

function buildCalorieSeries(cfg, weeks) {
  const pts = [{ weekStart: cfg.startDate || (weeks[0]?.weekStart ?? null), calories: cfg.startCalories, initial: true }];
  for (const w of weeks) pts.push({ weekStart: w.weekEnd, calories: w.targetCalories, delta: w.calorieDelta });
  return pts.filter((p) => p.weekStart);
}

function metricSummary(entries, key, windowDays, gridFrom, gridTo) {
  const pts = entries.map((e) => ({ t: toDayNum(e.date), v: e[key] }));
  const daily = dailyInterpolate(pts, gridFrom, gridTo);
  if (daily.length === 0) return { current: null, delta7: null, trend: [], first: null };
  const trend = rollingRegression(daily, windowDays);
  const current = trend[trend.length - 1];
  const back = Math.min(7, trend.length - 1);
  const delta7 = back > 0 ? current - trend[trend.length - 1 - back] : null;
  const known = pts.filter((p) => p.v != null);
  return {
    current: current != null ? round1(current) : null,
    delta7: delta7 != null ? round1(delta7) : null,
    first: known.length ? round1(known[0].v) : null,
  };
}

function avgCalories(entries, dayFrom, dayTo) {
  const vals = entries
    .filter((e) => { const t = toDayNum(e.date); return t >= dayFrom && t < dayTo && e.calories != null; })
    .map((e) => e.calories);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function buildRationale(x) {
  if (!x.hasEnoughData) {
    return 'Noch nicht genug Daten für eine Anpassung – trage weiter täglich deine Werte ein. Ab der ersten vollen Woche berechne ich deine Empfehlung.';
  }
  const rate = x.observedRatePerWeek;
  const adj = x.adjustment || {};
  const parts = [];
  if (rate != null) {
    const betrag = Math.abs(rate).toFixed(2).replace('.', ',');
    parts.push(`Dein Trend zeigt aktuell ${rate < 0 ? '−' : '+'}${betrag} kg/Woche.`);
  }
  if (adj.tooFast) {
    parts.push(`Das ist deutlich zu schnell (ab ${String(adj.fastLossLimit).replace('.', ',')} kg/Woche steuere ich gegen) – ich hebe dein Ziel um ${x.calorieDelta} kcal an, um Muskelverlust zu vermeiden.`);
    return parts.join(' ');
  }
  if (adj.hold === 'adaptation') {
    parts.push('Das ist mehr als geplant – in den ersten Wochen ist ein großer Teil davon Wasser und Glykogen, nicht Fett. Deshalb lasse ich dein Kalorienziel bewusst unverändert, statt vorschnell nachzusteuern; der Effekt läuft von selbst aus.');
    return parts.join(' ');
  }
  if (adj.hold === 'tolerance') {
    parts.push('Das liegt im Toleranzbereich um dein Ziel-Tempo – ich lasse dein Kalorienziel unverändert. Kleine Wochen-Schwankungen sind normal und kein Grund für eine Anpassung.');
    return parts.join(' ');
  }
  if (x.calorieDelta > 5) {
    parts.push(`Du liegst über dem Plan-Tempo – ich hebe dein Ziel um ${x.calorieDelta} kcal an, damit du kontrolliert im Kurs bleibst.`);
  } else if (x.calorieDelta < -5) {
    parts.push(`Du bist etwas zu langsam – ich senke dein Ziel um ${Math.abs(x.calorieDelta)} kcal.`);
  } else {
    parts.push('Du liegst gut im Plan – ich halte dein Ziel nahezu stabil.');
  }
  if (x.onScheduleStatus === 'ahead') parts.push('Du bist deinem geplanten Verlauf sogar voraus.');
  else if (x.onScheduleStatus === 'behind') parts.push('Ein kleiner Rückstand auf den Plan wird über die nächsten Wochen sanft ausgeglichen.');
  return parts.join(' ');
}

function baseResult(cfg) {
  const direction = cfg.goalWeight < cfg.startWeight ? -1 : 1;
  return {
    hasEnoughData: false,
    adjustment: {
      hold: null, tooFast: false, inAdaptation: true,
      rateTolerance: cfg.rateTolerance, fastLossLimit: cfg.fastLossLimit, waterKg: 0,
    },
    generatedFor: null,
    direction,
    config: cfg,
    today: null,
    trendWeight: null,
    startWeight: cfg.startWeight,
    goalWeight: cfg.goalWeight,
    totalToGo: round1(cfg.goalWeight - cfg.startWeight),
    progressPct: 0,
    observedRatePerWeek: null,
    targetRatePerWeek: round2(direction * Math.abs(cfg.weeklyRate)),
    maintenanceEstimate: null,
    recommendedCalories: cfg.startCalories,
    previousCalories: cfg.startCalories,
    calorieDelta: 0,
    onSchedule: { plannedWeightNow: cfg.startWeight, scheduleErrorKg: 0, status: 'on' },
    etaDate: null,
    etaWeeks: null,
    weeksElapsed: 0,
    rationale: buildRationale({ hasEnoughData: false }),
    metrics: {
      weight: { current: null, delta7: null, first: null },
      fatPct: { current: null, delta7: null, first: null },
      musclePct: { current: null, delta7: null, first: null },
      waterPct: { current: null, delta7: null, first: null },
    },
    weeks: [],
    series: { weight: [], plan: [], composition: [], calorieTargets: [] },
  };
}

// ── Zahlen-Helfer ────────────────────────────────────────────────────────
function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : null;
}
const round2 = (v) => Math.round(v * 100) / 100;
