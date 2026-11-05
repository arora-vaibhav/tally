// Royal LePage (royallepage.ca, French or English): the listing page lists each detail as a
// "Label:" line with its value on the next line, and Quebec listings carry Centris's
// potential gross revenue, taxes and expenses that way. The price and address are in the
// page's JSON-LD.
(function (L) {
  L.register({
    name: "Royal LePage",
    hosts: /(^|\.)royallepage\.ca$/i,
    async read(url, get, t) {
      const html = (await get(url)).body || "";
      const lines = t.htmlText(html).split("\n");
      const at = re => lines.findIndex(l => re.test(l));
      const next = re => { const i = at(re); return i < 0 ? "" : lines[i + 1] || ""; };
      const FIG = /^(?:\$\s?[\d\s,.]+|[\d\s,.]+\s?\$)$/;
      // a block's rows ("Residential:", "$57,000", ...) until a row with no figure
      const block = re => {
        const rows = {};
        for (let i = at(re) + 1; i > 0 && i < lines.length - 1 && FIG.test(lines[i + 1]); i += 2)
          rows[lines[i].replace(/\s*:$/, "")] = t.money(lines[i + 1]);
        return rows;
      };
      const sum = (o, ks) => (ks || Object.keys(o)).reduce((s, k) => s + o[k], 0) || null;

      const ld = t.jsonLd(html).find(o => o["@type"] === "RealEstateListing") || {};
      const a = (ld.mainEntity && ld.mainEntity.address) || {};
      const gross = block(/^(?:potential gross revenue|revenus bruts potentiels)\s*:$/i);
      const taxes = block(/^taxes\s*:$/i);
      const totalTax = Object.keys(taxes).find(k => /annual tax amount|taxes annuelles totales/i.test(k));
      const exp = block(/^(?:expenses|d[ée]penses)\s*:$/i);
      const energy = Object.keys(exp).filter(k => /[ée]lectri|electric|hydro|chauffage|heating|mazout|gaz|gas|[ée]nergie|energy/i.test(k));
      const ins = Object.keys(exp).filter(k => /assurance|insurance/i.test(k));
      const other = Object.keys(exp).filter(k => !energy.includes(k) && !ins.includes(k));
      const doors = Number(next(/^(?:number of units|nombre d.unit[ée]s)\s*:$/i)) || null;
      const f = {
        price: t.money(ld.offers && ld.offers.price),
        address: [a.streetAddress, a.addressLocality].map(s => t.decode(s || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(", "),
        doors,
        year: Number(next(/^(?:built in|b[âa]ti en)\s*:$/i)) || null,
        // Centris gives no total row for revenue, so its rows (residential, commercial, ...) are added up
        gross: sum(gross),
        taxes: totalTax ? taxes[totalTax] : sum(taxes),
        energy: sum(exp, energy),
        insurance: sum(exp, ins),
        otherListed: sum(exp, other),
        otherRows: other.map(k => k.toLowerCase()).join(", "),
        // a Quebec listing's MLS number is its Centris number
        centris: /(?:data provided by|donn[ée]es fournies par)\s*:?\s*centris/i.test(lines.join("\n")) ? (url.match(/\/mls(\d+)/i) || [])[1] || "" : "",
      };
      // Ontario pages give no unit count, only the building type ("Duplex"), which readListing counts
      const text = doors ? "" : [next(/^style\s*:$/i), next(/^(?:building type|type de b[âa]timent)\s*:$/i)].join("\n");
      return { text, fields: f };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
