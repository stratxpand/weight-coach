// Erzeugt realistische Demodaten, damit die App direkt „lebt", bevor du
// echte Werte einträgst. Wird nur im lokalen Modus beim ersten Start genutzt.
import { DEFAULT_CONFIG } from './analytics.js';

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

export function generateSeed(days = 42, endDate = new Date()) {
  const end = new Date(iso(endDate) + 'T00:00:00Z').getTime();
  const start = end - (days - 1) * DAY;

  const entries = [];
  const startWeight = 100.4;
  const lossPerDay = 0.55 / 7;         // ~0,55 kg/Woche (bewusst leicht über Ziel → Engine hebt kcal an)
  let fat = 28.4, muscle = 38.0;

  for (let i = 0; i < days; i++) {
    const t = start + i * DAY;
    const base = startWeight - lossPerDay * i;
    const noise = (Math.random() - 0.5) * 1.1;        // Tagesschwankung (Wasser etc.)
    const weight = round1(base + noise);

    fat -= 0.07 + (Math.random() - 0.5) * 0.05;         // Körperfett langsam runter
    muscle += 0.03 + (Math.random() - 0.5) * 0.04;      // Muskel langsam rauf
    const water = round1(55 + (Math.random() - 0.5) * 1.6);

    // an ~70 % der Tage auch gegessene Kalorien loggen (optional)
    const calories = Math.random() < 0.7 ? Math.round(2180 + (Math.random() - 0.5) * 260) : null;

    entries.push({
      date: iso(t),
      weight,
      musclePct: round1(muscle + (Math.random() - 0.5) * 0.3),
      fatPct: round1(fat + (Math.random() - 0.5) * 0.3),
      waterPct: water,
      calories,
    });
  }

  const config = {
    ...DEFAULT_CONFIG,
    startWeight: 100,
    goalWeight: 90,
    weeklyRate: 0.5,
    startCalories: 2200,
    startDate: entries[0].date,
  };

  return { entries, config };
}

const round1 = (v) => Math.round(v * 10) / 10;
