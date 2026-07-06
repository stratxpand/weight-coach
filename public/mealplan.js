// Dein Essensplan – exakte Werte aus deinem Ernährungs-Tracker.
// Die kcal-Zahl fürs Logging kommt aus config.planCalories (in den
// Einstellungen anpassbar); totalKcal dient als Referenz.
export const MEAL_PLAN = {
  title: 'Cut auf 90 kg',
  meta: '0,5 kg/Woche · Muskelerhalt · laktosefrei',
  totalKcal: 2188,
  totalProtein: 200,      // ~ geschätzt (Tracker zeigt nur kcal)
  proteinApprox: true,
  extras: 'Dazu: 3 Espresso · 3–4 L Wasser',
  meals: [
    {
      icon: '☀️', name: 'Frühstück · Shake', kcal: 333, items: [
        { n: 'Magerquark, Magerstufe (250 g)', kcal: 158 },
        { n: 'Beerenmischung TK (150 g)', kcal: 80 },
        { n: 'Chiasamen (12 g)', kcal: 58 },
        { n: 'Leinsamen (10 g)', kcal: 38 },
        { n: 'Creatin (ESN, 10 g)', kcal: 0 },
      ],
    },
    {
      icon: '🍗', name: 'Mittagessen · Reis & Hähnchen', kcal: 646, items: [
        { n: 'Hähnchenbrustfilet, gebraten (200 g)', kcal: 222 },
        { n: 'Jasmin Reis, gekocht (80 g)', kcal: 134 },
        { n: 'Zinzino Balance Oil (15 ml)', kcal: 126 },
        { n: 'Grüne Erbsen (80 g)', kcal: 77 },
        { n: 'Olivenöl (5 g)', kcal: 44 },
        { n: 'Brokkoli (100 g)', kcal: 27 },
        { n: 'TK-Spinat (100 g)', kcal: 17 },
      ],
    },
    {
      icon: '🥤', name: 'Snack · Protein-Shake', kcal: 424, items: [
        { n: 'Whey Vanilla (BULK, 45 g)', kcal: 165 },
        { n: 'Magerquark, Magerstufe (250 g)', kcal: 158 },
        { n: 'Beerenmischung TK (150 g)', kcal: 80 },
        { n: 'Flohsamenschalen (10 g)', kcal: 22 },
      ],
    },
    {
      icon: '🍳', name: 'Abendessen · Omelett', kcal: 785, items: [
        { n: 'Eier, gekocht (4 Stk · 240 g)', kcal: 329 },
        { n: 'Tofu, geräuchert (150 g)', kcal: 191 },
        { n: 'Vollkornbrot (1 Scheibe · 50 g)', kcal: 107 },
        { n: 'Rote Paprika (150 g)', kcal: 65 },
        { n: 'Olivenöl (5 g)', kcal: 44 },
        { n: 'Brokkoli (100 g)', kcal: 27 },
        { n: 'Zucchini (100 g)', kcal: 23 },
      ],
    },
  ],
};
