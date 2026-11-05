// RE/MAX Quebec (remax-quebec.com, French or English): the listing page is rendered on the
// server with Centris's financial block (taxes, expenses, potential gross revenue), each block
// ending in its own "Total" row. The price is in the page's JSON-LD; the unit count only in
// the broker's description, so that goes to readListing as text.
(function (L) {
  L.register({
    name: "RE/MAX Quebec",
    hosts: /(^|\.)remax-quebec\.com$/i,
    async read(url, get, t) {
      const html = (await get(url)).body || "";
      const lines = t.htmlText(html).split("\n");
      const at = re => lines.findIndex(l => re.test(l));
      const next = re => { const i = at(re); return i < 0 ? "" : lines[i + 1] || ""; };
      const FIG = /^(?:\$\s?[\d\s,.]+|[\d\s,.]+\s?\$)$/;
      // a block's rows: a label, maybe a "(2026)" line, then its figure; up to the block's Total
      const block = re => {
        const rows = {};
        let label = "";
        for (let i = at(re) + 1; i > 0 && i < lines.length; i++) {
          if (FIG.test(lines[i])) { if (label) rows[label] = t.money(lines[i]); if (label === "Total") break; }
          else if (!/^\(\d{4}\)$/.test(lines[i])) label = /^total$/i.test(lines[i]) ? "Total" : lines[i];
        }
        return rows;
      };
      const total = re => block(re).Total || null;

      const listing = h => t.jsonLd(h).find(o => o["@type"] === "RealEstateListing") || {};
      const ld = listing(html);
      // a listing written in French only has no description on its English page; take the French one
      const fr = (html.match(/<link[^>]+href="([^"]+)"[^>]*hreflang="fr"/i) || [])[1];
      if (!ld.description && fr && fr !== url) ld.description = listing((await get(fr)).body || "").description;
      const exp = block(/^(?:d[ée]penses annuelles|annual expenses)$/i);
      const ins = Object.keys(exp).find(k => /assurance|insurance/i.test(k));
      const other = Object.keys(exp).filter(k => k !== ins && k !== "Total");
      const sale = at(/^(?:à vendre|for sale|à louer|for rent)$/i);
      // a rental's JSON-LD price is the month's rent, never an asking price
      const rental = sale >= 0 && /louer|rent/i.test(lines[sale]);
      const f = {
        price: rental ? null : t.money(ld.offers && ld.offers.price),
        // the line after "à vendre" or "à louer" is "street, town (district)"
        address: sale < 0 ? "" : lines[sale + 1],
        year: Number(next(/^(?:ann[ée]e de construction|year constructed)$/i)) || null,
        // the ULS number is the Centris number
        centris: (lines.find(l => /^ULS\s*:/i.test(l)) || "").replace(/\D/g, ""),
        taxes: total(/^taxes$/i),
        energy: total(/^(?:d[ée]penses [ée]nerg[ée]tiques|energy expenses)$/i),
        insurance: ins ? exp[ins] : null,
        otherListed: other.reduce((a, k) => a + exp[k], 0) || null,
        otherRows: other.map(k => k.toLowerCase()).join(", "),
        gross: total(/^(?:revenus annuels bruts \(potentiels\)|gross annual revenues \(potential\))$/i),
      };
      // the category line above "à vendre" counts the doors when it is a word ("Quadruplex"),
      // never when it is a range ("8-15-Plex")
      const category = sale > 0 && !/\d/.test(lines[sale - 1]) ? lines[sale - 1] + "\n" : "";
      const text = t.decode(ld.description || "");
      // readListing takes "3 logements et 1 commerce" as 3 homes and no shop, and misses
      // "9 grands logements"; the prose counts win when it names shops or the category has no count
      const n = re => Number((text.match(re) || [])[1]) || 0;
      const com = n(/\b(\d{1,3})\s+(?:locaux commerciaux|local commercial|commerces?|commercial (?:units?|spaces?)|retail (?:units?|spaces?))\b/i);
      const res = n(/\b(\d{1,4})\s+(?:[a-zà-ÿ]+\s+)?(?:logements?|apartments?|residential (?:units?|dwellings?))\b/i);
      if (res && (com || !category)) Object.assign(f, { res, com });
      return { text: category + text, fields: f };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
