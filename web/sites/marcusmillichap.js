// Marcus & Millichap (marcusmillichap.com): the listing page is plain HTML with the price, the unit
// count and the address in labelled blocks. Gross, taxes and expenses are only in the offering
// memorandum behind a sign-in, so the page gives none of them.
(function (L) {
  const N = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  L.register({
    name: "Marcus & Millichap",
    hosts: /(^|\.)marcusmillichap\.com$/i,
    async read(url, get, t) {
      const h = (await get(url)).body;
      // a removed listing answers 200 with the search page
      if (!/score-hero-body"/i.test(h)) throw new Error("that listing is no longer on the site");
      const spec = label => (h.match(new RegExp(`specification-name">${label}</div>\\s*<div class="specification-value">\\s*([^<]*)`, "i")) || [])[1] || "";
      const addr = t.decode((h.match(/score-hero-body">\s*<p>\s*([^<]*)/i) || [])[1] || "").trim();
      const year = h.match(/\b(?:built|constructed) in ((?:18|19|20)\d{2})\b/i);
      // "Number of Units" counts shops too, so commercial spaces the highlights name come off it;
      // a page that says mixed-use but gives no count gets no doors rather than all of them as homes
      const about = t.htmlText((h.match(/score-hero-body[\s\S]*?(?=mm-lead|$)/i) || [""])[0]);
      const cm = about.match(/\b(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[\w-]+\s+)?(?:commercial|retail)\s+(?:spaces?|units?|suites?|storefronts?)\b/i);
      const total = parseInt(spec("Number of Units"), 10) || 0;
      const com = cm ? N[cm[1].toLowerCase()] || Number(cm[1]) : 0;
      const units = com && com < total ? { res: total - com, com }
        : /\b(?:commercial|retail|mixed[- ]use)\b/i.test(about) ? {} : { doors: total };
      return { fields: Object.assign({
        // "Request For Offer" is no price
        price: t.money((h.match(/mm-property-price">\s*Listing Price:\s*([^<]*)/i) || [])[1]),
        year: year ? Number(year[1]) : null,
        // "607 Timberpine Ave, Sunnyvale, CA 94086": the state and postal code go, so it ends in the town
        address: addr.replace(/,\s*[A-Z]{2}\b[^,]*$/, ""),
      }, units) };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
