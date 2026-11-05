// Avison Young (avisonyoung.ca, .com, .us, French or English) and the SharpLaunch microsites its
// listings live on (x.sharplaunch.com): the page is the SharpLaunch site, a list of label and
// value pairs ("Number of units 35", "Asking price $2,190,000") that reads like a copied page.
(function (L) {
  async function read(url, get, t) {
    const r = await get(url);
    // a reduced price keeps the old one struck out next to it
    const html = r.body.replace(/<(del|s|strike)\b[^>]*>[\s\S]*?<\/\1>|<span[^>]*line-through[^>]*>[^<]*<\/span>/gi, "");
    const fields = {};
    // the price pair is read here, since its label may run on ("Prix demandé réduit", "Pricing
    // Guidance") and its value may end in "CAD", which the text reader does not take
    for (const [, k, v] of html.matchAll(/<li>\s*<span>([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span>\s*<\/li>/gi)) {
      const label = t.htmlText(k), n = t.money(t.htmlText(v));
      // under 10,000 is "price on request" written as $1, not a price
      if (n >= 10000 && /\b(price|prix|pricing|asking)\b/i.test(label) && !/\b(per|par)\b|\/|assess|[ée]valuation/i.test(label)) fields.price = n;
    }
    const text = t.htmlText(html);
    // the headline gives the commercial space the unit pair leaves out: "35 units & one commercial
    // space", "35 logements et un espace commercial"
    const mix = text.match(/\b(\d{1,4})\s+(?:units?|logements?|unit[ée]s)\s+(?:&|and|et)\s+(one|une?|\d{1,3})\s+(?:commercial|(?:e?s?paces?|locaux|local)\s+commerci)/i);
    if (mix) { fields.res = Number(mix[1]); fields.com = /^\d/.test(mix[2]) ? Number(mix[2]) : 1; }
    // "Twenty (20) stratified rental apartment units", used only when nothing else gives a count
    const spelled = text.match(/\((\d{1,4})\)[^.\n()]{0,50}?\b(?:units|suites|apartments|logements)\b/i);
    if (spelled) fields.doors = Number(spelled[1]);
    // avisonyoung pages carry the address in JSON-LD; the street sometimes already holds the town
    const a = (t.jsonLd(html).find(o => o.address && o.address.streetAddress) || {}).address;
    if (a) fields.address = [a.streetAddress.split(", " + a.addressLocality)[0], a.addressLocality].filter(Boolean).join(", ");
    else {
      // a bare microsite: the hero line "1148 Oscar Street, Victoria, BC", province dropped
      const m = html.match(/hero__sub-title[^>]*>([^<]*,[^<]*)</);
      if (m) fields.address = t.decode(m[1]).trim().replace(/,\s*[A-Z]{2}(\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d|\s+\d{5})?$/, "");
    }
    return { text, fields };
  }
  // AY's own microsites are named "ayca..." (ayca1148oscarstreet); other brokerages use SharpLaunch too
  L.register({ name: "Avison Young", hosts: /(^|\.)avisonyoung\.(ca|com|us)$|^ay[^.]*\.sharplaunch\.com$/i, read });
  L.register({ name: "SharpLaunch", hosts: /(^|\.)sharplaunch\.com$/i, read });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
