// Royal LePage Commercial (royallepagecommercial.com, French or English): the page is filled in
// by the browser, but the site's own public API gives the listing as JSON by its id, the part
// of the link after /property/. Unit counts and income are only in the broker's description.
(function (L) {
  L.register({
    name: "Royal LePage Commercial",
    hosts: /(^|\.)royallepagecommercial\.com$|^rlpcommercial\.azurewebsites\.net$/i,
    async read(url, get, t) {
      const id = (new URL(url).pathname.match(/\/property\/(?:detail\/)?([^/]+)/i) || [])[1];
      if (!id) throw new Error("that Royal LePage Commercial link is not a listing; open the listing and share its link");
      const p = JSON.parse((await get("https://www.royallepagecommercial.com/api/property_cosmos/" + encodeURIComponent(id))).body);
      // features come as [english label, french label] with [[english value], [french value]]
      const feat = re => { const x = [].concat(p.propFeatures || [], p.buildingFeatures || []).find(x => re.test(x.feature[0])); return x ? String(x.values[0][0] || "") : ""; };
      const f = {
        price: p.status === "sale" ? t.money(p.sale_price) : null,
        address: [p.address, p.city].map(s => (s || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(", "),
        year: Number(feat(/^built in/i)) || null,
        taxes: t.money(p.taxAmount) || t.money(feat(/^annual tax amount/i)),
        // buildingUnits is often blank or junk ("FEET"); only a plain count is used
        doors: /^\d+$/.test(p.buildingUnits || "") ? Number(p.buildingUnits) : null,
        // a Quebec listing's id is its Centris number
        centris: p.province === "QC" && /^\d{7,9}$/.test(p.mls_id || "") ? p.mls_id : "",
      };
      // "residential units" in prose is reworded so readListing does not take the rest of the
      // sentence as the unit mix
      const text = (p.description || "").replace(/residential units/gi, "residential dwellings").replace(/unit[ée]s r[ée]sidentielles/gi, "logements résidentiels");
      // readListing reads "5plex ... 2 locaux commerciaux et 3 logements" as 5 homes; when the
      // prose names shops, its own counts win
      const n = re => Number((text.match(re) || [])[1]) || 0;
      const com = n(/\b(\d{1,3})\s+(?:locaux commerciaux|local commercial|commerces?|commercial (?:units?|spaces?)|retail (?:units?|spaces?))\b/i);
      const res = n(/\b(\d{1,4})\s+(?:logements?|apartments?|residential (?:units?|dwellings?))\b/i);
      if (com && res) Object.assign(f, { res, com });
      return { text, fields: f };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
