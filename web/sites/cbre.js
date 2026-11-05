// CBRE (cbre.ca and cbre.com, French or English): the listing page is an empty shell that asks
// CBRE's property API for the listing, so the reader asks it too, by the id in the link
// (".../details/CA-Plus-442046/..."). Price, year and address are fields there; the units
// are only in the description, which is read as text unless the listing is land or a project.
(function (L) {
  L.register({
    name: "CBRE",
    hosts: /(^|\.)cbre\.(ca|com|us)$/i,
    async read(url, get, t) {
      const id = (url.match(/\b(?:CA|US)-[A-Za-z]+-\d+\b/) || [])[0];
      if (!id) throw new Error("that CBRE link is not a listing; open the listing itself and paste its link");
      const api = id.startsWith("CA")
        ? "https://www.cbre.ca/property-api/propertylistings/query?Site=ca-comm&Common.PrimaryKey=" + id
        : "https://www.cbre.com/listings-api/propertylistings/query?site=us-comm&Common.PrimaryKey=" + id;
      const blocked = "CBRE does not let apps read its pages; open the listing, copy the page and paste the text";
      let r, j;
      try { r = await get(api); } catch (e) {
        // Cloudflare turns some requests away (403, 429, 503)
        if (/blocked|status 503/.test(e.message)) throw new Error(blocked);
        throw e;
      }
      // or answers 200 with its challenge page instead of the listing
      try { j = JSON.parse(r.body); } catch (e) { throw new Error(blocked); }
      const docs = [].concat(...((j && j.Documents) || []));
      const x = docs.find(d => d["Common.PrimaryKey"] === id) || docs[0];
      if (!x) throw new Error("CBRE has no listing " + id + " any more");
      const a = x["Common.ActualAddress"] || {};
      // Line1 is sometimes the building's name ("Scotia Manor") and the street comes next
      const lines = ["Common.Line1", "Common.Line2", "Common.Line3"].map(k => (a[k] || "").trim()).filter(Boolean);
      const street = lines.find(s => /^\d/.test(s)) || lines[0];
      const sale = (x["Common.Charges"] || []).find(c => c["Common.ChargeKind"] === "SalePrice");
      // the description in the link's language when CBRE has it
      const fr = /\/fr(\/|-|$)/i.test(new URL(url).pathname);
      const say = k => {
        const all = x[k] || [];
        const one = all.find(d => /^fr/i.test(d["Common.CultureCode"]) === fr) || all[0];
        return one ? one["Common.Text"] : "";
      };
      const text = [say("Common.Strapline"), say("Common.LongDescription")].join("\n");
      const fields = {
        price: sale ? t.money(sale["Common.Amount"]) : null,
        year: x["Common.YearBuilt"] || null,
        address: [street, (a["Common.Locallity"] || "").trim()].filter(Boolean).join(", "),
      };
      // on land or a project the units in the description are planned ones, not doors to run
      if (x["Dynamic.DevelopmentOpportunity"] || (x["Common.PropertyTypes"] || []).includes("Land")
        || /\b(d[ée]velop(?:ment|pement)|buildable|constructible|d[ée]molition|approved for|zoned for)\b/i.test(text)) fields.res = fields.com = 0;
      return { text, fields };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
