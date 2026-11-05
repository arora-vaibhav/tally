// Zillow (zillow.com): the listing page carries the listing in __NEXT_DATA__ (gdpClientCache).
// The page text is not read: its tax and insurance lines are Zillow's own estimates, not the
// listing's. The seller's description is free prose, so it is not handed to readListing (which
// would take "2 units are vacant" as the door count); only a unit count tied to the building is
// taken from it ("Legal 3 unit", "three-unit building", "4-flat").
(function (L) {
  const BLOCKED = "Zillow does not let apps read its pages; open the listing, copy the page and paste the text";
  const N = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const W = "(\\d{1,3}|" + Object.keys(N).join("|") + ")";
  const num = s => +s || N[s.toLowerCase()] || null;
  function units(d) {
    const u = d.match(new RegExp("\\blegal\\s+" + W + "[- ]units?\\b|\\b" + W + "[- ]unit\\s+(?:building|property|apartment|multi)", "i"));
    if (u) return num(u[1] || u[2]);
    // a Chicago "2 flat with garden unit" is three doors, so a flat count only stands alone
    const f = !/garden unit|coach house/i.test(d) && d.match(new RegExp("\\b" + W + "[- ]flat\\b", "i"));
    return f ? num(f[1]) : null;
  }
  L.register({
    name: "Zillow",
    hosts: /(^|\.)zillow\.com$/i,
    async read(url, get) {
      let r;
      try { r = await get(url); } catch (e) {
        if (/blocked/.test(e.message)) throw new Error(BLOCKED); // 403 or 429 is its bot wall
        throw e;
      }
      const body = r.body || "";
      const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      let p;
      try {
        let c = JSON.parse(m[1]).props.pageProps.componentProps.gdpClientCache;
        if (typeof c === "string") c = JSON.parse(c);
        p = Object.values(c)[0].property;
      } catch (e) { p = null; }
      // every Zillow page loads PerimeterX, so its name only means a wall when no listing came back
      if (!p && /px-captcha|perimeterx/i.test(body)) throw new Error(BLOCKED);
      if (!p) throw new Error("this Zillow link is not a listing");
      const a = p.address || {};
      return {
        text: "",
        fields: {
          price: p.price > 0 ? p.price : null,
          res: units(p.description || ""),
          year: (p.resoFacts && p.resoFacts.yearBuilt) || p.yearBuilt || null,
          address: [a.streetAddress, a.city].filter(Boolean).join(", "),
        },
      };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
