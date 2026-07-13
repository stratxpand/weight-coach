// ─────────────────────────────────────────────────────────────────────────
//  coach.js — KI-Coach auf Basis von Claude (Anthropic)
//
//  Bekommt die fertige Analyse (Trendgewicht, Ist-/Ziel-Tempo, geschätzter
//  Erhaltungsbedarf, empfohlene Wochen-Kalorien) plus den Essensplan und
//  liefert eine kurze Bewertung + KONKRETE, minimale Anpassungen am Plan,
//  damit der Nutzer sein Wochenziel trifft. Struktur-Ausgabe (JSON-Schema),
//  daher garantiert parsebar.
// ─────────────────────────────────────────────────────────────────────────

const MODEL = process.env.COACH_MODEL || 'claude-opus-4-8';

const COACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['on_track', 'eat_more', 'eat_less'] },
    assessment: { type: 'string' },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          change: { type: 'string' },      // z. B. "Reis mittags 80 g → 60 g"
          deltaKcal: { type: 'integer' },   // Auswirkung, z. B. -70
        },
        required: ['change', 'deltaKcal'],
      },
    },
    newPlanCalories: { type: 'integer' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'assessment', 'adjustments', 'newPlanCalories', 'summary'],
};

const SYSTEM = `Du bist ein erfahrener, evidenzbasierter Ernährungs- und Fitness-Coach.
Der Nutzer ist in einer Diät (Cut) mit dem Ziel Muskelerhalt.

Feste Regeln:
- laktosefrei
- hoher Proteinanteil (~1,8–2,2 g pro kg Körpergewicht) beibehalten
- nur realistische, minimale Anpassungen am bestehenden Plan – keine radikalen Sprünge
- empfiehl niemals ein Tagesziel unter ca. 1400 kcal
- rechne mit ~7700 kcal pro kg Körpermasse

WICHTIG – Anlaufphase und Toleranz:
- In den ersten Diät-Wochen ist ein erheblicher Teil der Abnahme Wasser und Glykogen, kein Fett.
  Eine erste Woche mit z. B. 1 kg statt 0,5 kg ist damit völlig normal und KEIN Grund, das
  Kalorienziel anzuheben. Der Effekt läuft von selbst aus.
- Kleine Abweichungen vom Ziel-Tempo (innerhalb der unten genannten Toleranz) sind Rauschen.
  Dann: verdict "on_track", keine oder nur kosmetische Anpassungen, newPlanCalories unverändert.
- Erst wenn die Abnahme dauerhaft ODER sehr deutlich zu schnell ist (siehe "Zu-schnell-Schwelle"),
  empfiehlst du "eat_more". Die App sagt dir unten explizit, ob sie das Ziel bewusst hält –
  in dem Fall widersprich ihr nicht, sondern erkläre dem Nutzer ruhig, warum gehalten wird.

Deine Aufgabe:
- Bewerte kurz, ob der Nutzer im Plan liegt (verdict: on_track / eat_more / eat_less).
- "eat_less" wenn er zu langsam abnimmt (Kalorien runter), "eat_more" nur wenn er
  über die Anlaufphase hinaus klar zu schnell abnimmt.
- Schlage 1–4 konkrete Zutaten-Anpassungen am Essensplan vor, jeweils mit kcal-Auswirkung,
  die den Nutzer nahe an das empfohlene Tagesziel bringen und Protein hoch halten.
- Nenne ein neues Tages-Kalorienziel (newPlanCalories), nahe an der App-Empfehlung.

Antworte sachlich, motivierend und knapp auf Deutsch. Halte dich strikt an das JSON-Schema.`;

export async function coachAdvice({ analysis, mealPlan, config }) {
  const planCalories = Math.round(config?.planCalories ?? mealPlan?.totalKcal ?? analysis.recommendedCalories);

  // Ohne volle Woche gibt es keine datenbasierte Empfehlung → freundlich abkürzen (spart API-Kosten).
  if (!analysis.hasEnoughData) {
    return {
      configured: true,
      verdict: 'on_track',
      assessment: 'Es liegt noch keine vollständige Woche vor. Iss weiter nach Plan und trage täglich dein Gewicht ein – nach der ersten vollen Woche gebe ich dir eine datenbasierte Anpassung.',
      adjustments: [],
      newPlanCalories: planCalories,
      summary: 'Weiter so – Daten sammeln.',
      model: MODEL,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('KI-Coach nicht konfiguriert: Umgebungsvariable ANTHROPIC_API_KEY fehlt.');
    err.code = 'NO_KEY';
    throw err;
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: COACH_SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(analysis, mealPlan, planCalories) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Die Anfrage wurde vom Modell abgelehnt.');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Keine verwertbare Antwort vom Modell erhalten.');

  const data = JSON.parse(textBlock.text);
  const minCal = Math.round(config?.minCalories ?? 1400);
  return {
    configured: true,
    verdict: data.verdict,
    assessment: String(data.assessment || ''),
    adjustments: Array.isArray(data.adjustments) ? data.adjustments.slice(0, 6) : [],
    newPlanCalories: Math.max(minCal, Math.round(data.newPlanCalories || planCalories)),
    summary: String(data.summary || ''),
    model: MODEL,
  };
}

function holdText(adj) {
  if (adj.tooFast) return 'Abnahme ist zu schnell → Kalorienziel wird angehoben.';
  if (adj.hold === 'adaptation') return 'Ziel wird bewusst GEHALTEN – die Extra-Abnahme ist Anlaufphase (Wasser/Glykogen), keine echte Übererfüllung. Empfiehl hier KEIN "eat_more".';
  if (adj.hold === 'tolerance') return 'Ziel wird GEHALTEN – Abweichung liegt im Toleranzband.';
  return 'Ziel wird regulär nachjustiert.';
}

function buildPrompt(a, mealPlan, planCalories) {
  const dir = a.direction < 0 ? 'abnehmen' : 'zunehmen';
  const adj = a.adjustment || {};
  const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d).replace('.', ','));
  const meals = (mealPlan?.meals || [])
    .map((m) => `- ${m.name} (~${m.kcal} kcal): ${(m.items || []).map((i) => `${i.n} ${i.kcal}kcal`).join('; ')}`)
    .join('\n');
  const weeks = (a.weeks || []).slice(-3)
    .map((w) => `  Woche ${w.index}: Trend ${fmt(w.trendEnd)} kg, Ist-Tempo ${fmt(w.observedRate, 2)} kg/Wo, Ziel-kcal ${w.targetCalories}`)
    .join('\n');

  return `ZIEL & PLAN
- Richtung: ${dir} von ${fmt(a.startWeight)} kg auf ${fmt(a.goalWeight)} kg
- Ziel-Tempo: ${fmt(Math.abs(a.targetRatePerWeek), 2)} kg/Woche, Muskelerhalt, laktosefrei

AKTUELLER STAND (Woche ${fmt(a.weeksElapsed, 0)})
- Trendgewicht: ${fmt(a.trendWeight)} kg (noch ${fmt(Math.abs(a.totalToGo))} kg bis zum Ziel)
- Ist-Tempo zuletzt: ${fmt(a.observedRatePerWeek, 2)} kg/Woche (Ziel: ${fmt(a.targetRatePerWeek, 2)})
- Status vs. Plan: ${a.onSchedule?.status} (Abweichung ${fmt(a.onSchedule?.scheduleErrorKg)} kg)
- Geschätzter Erhaltungsbedarf: ${a.maintenanceEstimate ?? '—'} kcal/Tag
- App-Empfehlung fürs Kalorienziel der nächsten Woche: ${a.recommendedCalories} kcal/Tag

ANPASSUNGS-LOGIK DER APP
- Toleranz um das Ziel-Tempo: ±${fmt(adj.rateTolerance, 2)} kg/Woche → innerhalb davon wird nicht angepasst
- Zu-schnell-Schwelle: ab ${fmt(adj.fastLossLimit, 2)} kg/Woche wird gegengesteuert
- Anlaufphase (Wasser/Glykogen): ${adj.inAdaptation ? 'ja, läuft noch' : 'abgeschlossen'}${adj.waterKg ? ` – ${fmt(adj.waterKg, 2)} kg der letzten Woche wurden als Wasser verbucht` : ''}
- Entscheidung der App für diese Woche: ${holdText(adj)}

WOCHENVERLAUF
${weeks || '  (keine Historie)'}

AKTUELLER ESSENSPLAN (~${planCalories} kcal/Tag, ~${mealPlan?.totalProtein ?? '—'} g Protein)
${meals || '  (kein Plan übermittelt)'}

Bewerte den Fortschritt und schlage konkrete Plan-Anpassungen vor, die mich möglichst nah an die App-Empfehlung (${a.recommendedCalories} kcal) bringen, Protein hoch halten und laktosefrei bleiben. Nenne ein neues Tagesziel (newPlanCalories).`;
}
