// DuProprio (duproprio.com, French or English): sold by owners. The page lists its facts as
// label and value rows (price, year, yearly revenue, then one row per unit size with its count)
// and a costs table with a monthly and a yearly column, of which the yearly one is read.
(function (L) {
  const PLEX = { duplex: 2, triplex: 3, quadruplex: 4, quintuplex: 5 };
  const TAX = /municipal|scolaire|school|d.eau|water/i;
  const ENERGY = /[ée]lectricit[ée]|electricity|chauffage|heating|\bgaz\b|\bgas\b|mazout|oil/i;

  L.register({
    name: "DuProprio",
    hosts: /(^|\.)duproprio\.com$/i,
    async read(url, get, t) {
      const r = await get(url), h = r.body;
      const text = s => t.htmlText(s).split("\n");
      const f = {};

      // the facts: <div class="listing-box__dotted-row"><div>label</div><div></div><div>value</div>
      const rows = h.split('class="listing-box__dotted-row"').slice(1).map(s => text("<div " + s.split(/<\/div>\s*<\/div>/)[0]));
      const fact = re => (rows.find(x => re.test(x[0])) || [])[1] || "";
      const p = h.match(/preloadedState\.listing\s*=\s*\{[^}]*"price":(\d+)/);
      f.price = p ? Number(p[1]) : t.money(fact(/^(?:prix demand[ée]|asking price)$/i));
      const y = fact(/^(?:ann[ée]e de construction|year of construction)$/i).match(/(?:18|19|20)\d{2}/);
      if (y) f.year = Number(y[0]);

      // one row per unit size ("3 1/2", "6 1/2 et plus", "1 Bedroom") with the count beside it.
      // The owner types these rows, so when they disagree with the plex word (triplex = 3), the
      // word wins and the mix is dropped.
      const units = rows.filter(([k, v]) => /^\d+\s*(?:1\/2|½|bedrooms?|chambres?)\b|^(?:studio|loft|bachelor)/i.test(k) && /^\d+$/.test(v));
      const sum = units.reduce((a, [, v]) => a + Number(v), 0);
      const plex = PLEX[((h.match(/listing-location__title[\s\S]{0,400}?\b(duplex|triplex|quadruplex|quintuplex)\b/i) || [])[1] || "").toLowerCase()];
      if (plex && sum !== plex) f.res = plex;
      else if (units.length) { f.res = sum; f.unitMix = units.map(([k, v]) => `${v} x ${k}`).join(", "); }
      const com = fact(/^(?:number of commercial units|nombre d.unit[ée]s commerciales|nombre de locaux commerciaux)$/i);
      if (/^\d+$/.test(com)) f.com = Number(com);

      // the costs and revenue tables: each row is its name, the month, then the year
      const table = h.split(/class="mortgage-data__table__row(?:__footer)?"/).slice(1).map(s => text("<div " + s).slice(0, 3));
      let taxes = 0, energy = 0, other = 0, gross = null; const otherRows = [];
      for (const [k, , year] of table) {
        const v = t.money(year);
        if (!v || !/\$/.test(year)) continue;
        if (/^(?:revenus|revenues|income)$/i.test(k)) gross = v;
        else if (TAX.test(k) && /tax/i.test(k)) taxes += v;
        else if (/assurance|insurance/i.test(k)) f.insurance = v;
        else if (ENERGY.test(k)) energy += v;
        else { other += v; otherRows.push(k.toLowerCase()); }
      }
      f.gross = gross || t.money(fact(/^(?:revenus annuels|annual income)$/i));
      const cents = n => Math.round(n * 100) / 100; // the rows carry cents, and adding them drifts
      if (taxes) f.taxes = cents(taxes);
      if (energy) f.energy = cents(energy);
      if (other) { f.otherListed = cents(other); f.otherRows = otherRows.join(", "); }

      // the street, then the town (or borough) the page names under it
      const a = (h.match(/<p class="listing-location__address">([\s\S]*?)<\/p>/) || [])[1] || "";
      const spans = [...a.matchAll(/<span>([^<]+)<\/span>/g)].map(m => t.decode(m[1]).trim());
      f.address = spans.slice(0, 2).join(", ");
      return { fields: f };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
