// PMML (pmml.ca, French or English): the property page carries the broker's Income & Expenses
// table (one row a line, cells split by tabs, the yearly figure the first one with a $ in it).
// The napkin adds its own management, repairs and reserve, so the broker's normalised rows for
// those are left out of the other costs.
(function (L) {
  const TAX = /municipal|scolaire|school|taxes? d.eau|water tax/i;
  const ENERGY = /electricity|[ée]lectricit[ée]|heating|chauffage|\bgaz\b|\bgas\b|mazout/i;
  const NAPKIN = /administration|management|gestion|maintenance|entretien|r[ée]serve|chmc|schl/i;

  L.register({
    name: "PMML",
    hosts: /(^|\.)pmml\.ca$/i,
    async read(url, get, t) {
      const r = await get(url);
      const lines = t.htmlText(r.body).split("\n");
      const cells = l => l.split("\t").map(c => c.trim());
      const yearly = l => { const c = cells(l).slice(1).find(c => c.includes("$")); return c ? t.money(c) : null; };
      const row = re => lines.find(l => re.test(cells(l)[0]));
      const f = {};

      // "Asking Price : $4,840,000" in the header, or the label with its figure on the next line
      const p = lines.findIndex(l => /^(?:asking price|prix demand[ée])(?![a-z])/i.test(l));
      if (p >= 0) f.price = t.money(lines[p].replace(/^[^:]*:?/, "")) || t.money(lines[p + 1]);

      // the header count ("18 Units", "6 Unités") is what is for sale; the units row may describe a
      // bigger project, so it only splits residential from commercial
      const head = lines.find(l => /^\d+\s+(?:units?|unit[ée]s)$/i.test(l));
      if (head) f.doors = parseInt(head, 10);
      const u = cells(row(/^(?:number of units|nombre d.unit[ée]s)$/i) || "")[1] || "";
      const res = u.match(/(\d+)\s*(?:residential|r[ée]sidenti)/i), com = u.match(/(\d+)\s*(?:retail|commerci|office|bureau|local|locaux)/i);
      if (res || com) { f.res = res ? Number(res[1]) : 0; f.com = com ? Number(com[1]) : 0; }
      else if (!f.doors && /^\d+$/.test(u)) f.doors = Number(u);
      // retail pages have neither, but may say it plainly: "3 commercial units and 2 large 6.5-room apartments"
      const mix = !f.doors && !res && !com && lines.map(l => l.match(/\b(\d+)\s+(?:[\w-]+\s+)?(?:commercial units?|locaux commerciaux)\s+(?:and|et)\s+(\d+)\s+(?:[\w.-]+\s+){0,3}(?:apartments?|residential|logements?)\b/i)).find(Boolean);
      if (mix) { f.com = Number(mix[1]); f.res = Number(mix[2]); }

      // before vacancy, so potential gross; retail pages add the expense recoveries below the
      // revenues and total both as "Total Gross Income", as multifamily pages do inside the revenues
      const gross = row(/^(?:total gross income|revenus? bruts? totaux?)$/i) || row(/^(?:total revenues|revenus totaux)$/i);
      if (gross) f.gross = yearly(gross);

      // the expense rows, from the Expenses heading to the total
      const a = lines.findIndex(l => /^(?:expenses|d[ée]penses)$/i.test(l));
      const b = lines.findIndex((l, i) => i > a && /^(?:total expenses|d[ée]penses totales)\b/i.test(l));
      let taxes = 0, energy = 0, other = 0; const otherRows = [];
      if (a >= 0) for (const l of lines.slice(a + 1, b > a ? b : undefined)) {
        const label = cells(l)[0], v = yearly(l);
        if (!v) continue;
        if (TAX.test(label)) taxes += v;
        else if (/^(?:insurance|assurances?)$/i.test(label)) f.insurance = v;
        else if (ENERGY.test(label)) energy += v;
        else if (!NAPKIN.test(label)) { other += v; otherRows.push(label.toLowerCase()); }
      }
      if (taxes) f.taxes = taxes;
      if (energy) f.energy = energy;
      if (other) { f.otherListed = other; f.otherRows = otherRows.join(", "); }

      const y = (cells(row(/^(?:year of construction|ann[ée]e de construction)$/i) || "")[1] || "").match(/(?:18|19|20)\d{2}/);
      if (y) f.year = Number(y[0]); // a range ("2022 - 2024") gives its first year
      // the title, not og:title: meta() stops at an apostrophe ("Bord-de-l'Eau")
      f.address = t.decode((r.body.match(/<title[^>]*>([^<]*)/i) || [])[1] || "").replace(/\s*\|\s*PMML\s*$/i, "").replace(/\s+/g, " ").trim();
      return { fields: f };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
