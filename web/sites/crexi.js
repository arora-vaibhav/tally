// Crexi (crexi.com): the page sits behind a Cloudflare check, but it is drawn from Crexi's own
// public API (api.crexi.com/assets/<id>), which answers a plain request. Figures Crexi keeps for
// signed-in users come back as "****" and stay empty; the broker's text fills in units and the like.
(function (L) {
  const shown = v => (v && !/^\*+$/.test(v) ? v : null); // "****" is a figure hidden from guests
  L.register({
    name: "Crexi",
    hosts: /(^|\.)crexi\.com$/i,
    async read(url, get, t) {
      const id = (url.match(/\/properties\/(\d+)/) || [])[1];
      if (!id || /\/lease\//i.test(url)) throw new Error("that Crexi link is not a property for sale; open the listing and copy its link");
      const a = JSON.parse((await get("https://api.crexi.com/assets/" + id)).body);
      const d = a.details || {}, loc = (a.locations || [])[0] || {};
      const units = Number(String(shown(d.Units) || "").replace(/,/g, "")) || null;
      const year = Number(shown(d["Year Built"])) || null;
      // an auction's askingPrice is the starting bid, not a price: the user types the price
      const auction = a.status === "Auction" || "Starting Bid" in d || /\bauction\b/i.test(a.name || "");
      let text = [a.name, shown(d.Units) ? "Units: " + d.Units : "", a.investmentHighlights, a.marketingDescription, a.description]
        .filter(Boolean).map(s => t.htmlText(String(s))).join("\n");
      // "24 units built in 1981 and 8 built in 2011" is no one year, so the text gives none
      const built = new Set((text.match(/\bbuilt(?: in)?\s*:?\s*(?:18|19|20)\d{2}/gi) || []).map(m => m.slice(-4)));
      if (built.size > 1) text = text.replace(/\bbuilt\b/gi, "dating");
      return { text, fields: { price: auction ? null : t.money(a.askingPrice), res: units, year,
        address: [loc.address, loc.cityVerified || loc.city].filter(Boolean).join(", ") } };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
