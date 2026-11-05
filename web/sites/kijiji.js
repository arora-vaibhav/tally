// Kijiji (kijiji.ca, French or English): the ad is in the page's Next.js data. The price is
// there in cents; units, revenue and the rest are only in the seller's own words, so the title
// and description are read as text, like a copied ad.
// shortcut: a "triplex" title counts 3 units even when the ad says the third is only possible
// (deal.js reads the title); fix it in readListing if sellers' titles keep misleading.
(function (L) {
  L.register({
    name: "Kijiji",
    hosts: /(^|\.)kijiji\.ca$/i,
    async read(url, get, t) {
      const html = (await get(url)).body;
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      const state = m ? JSON.parse(m[1]).props.pageProps.__APOLLO_STATE__ || {} : {};
      const id = (url.match(/\/(\d{6,})(?:[?#]|$)/) || [])[1];
      const ad = state["StandardListing:" + id] || Object.values(state).find(v => v && /Listing$/.test(v.__typename || ""));
      if (!ad) return { text: t.htmlText(html) }; // no ad data: read the page as a copy would
      const cents = ad.price && ad.price.amount;
      // "rue Sherbrooke, Lachine, QC, H8S 1G7": the province and postal code go, the town ends it
      const address = ((ad.location || {}).address || "").replace(/,\s*(?:QC|ON|AB|BC|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b.*$/, "").trim();
      return { text: ad.title + "\n" + t.htmlText(ad.description || ""), fields: { price: cents ? cents / 100 : null, address } };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
