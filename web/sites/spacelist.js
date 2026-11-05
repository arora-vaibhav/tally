// Spacelist (spacelist.ca): the listing page is plain HTML, its facts in "key / value" pairs
// (Asking Price, Taxes, Year Built). It gives no unit count or revenue of its own, so the doors
// come only from counts the broker's description states outright. The description is not read as
// a listing: free prose gave readListing stray unit mixes and counted a semi-commercial duplex as
// two homes. Spacelist sits behind Cloudflare, which lets Tally's Go fetch through but blocks some
// clients (Node's fetch gets 403), so a block gets the standard paste message.
(function (L) {
  const NUM = "\\d{1,4}|an?|une?|one|two|three|four|five|six|seven|eight|nine|ten|deux|trois|quatre|cinq|sept|huit|neuf|dix";
  const N = { a: 1, an: 1, un: 1, une: 1, one: 1, two: 2, deux: 2, three: 3, trois: 3, four: 4, quatre: 4, five: 5, cinq: 5,
    six: 6, seven: 7, sept: 7, eight: 8, huit: 8, nine: 9, neuf: 9, ten: 10, dix: 10 };
  // "13 residential apartments", "six résidentielles", "deux espaces commerciaux", "a prime ground-floor commercial unit"
  const count = (s, word) => {
    const m = s.match(new RegExp(`(?<![\\p{L}\\d])(${NUM})\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:${word})`, "iu"));
    return m ? N[m[1].toLowerCase()] || Number(m[1]) : 0;
  };
  L.register({
    name: "Spacelist",
    hosts: /(^|\.)spacelist\.ca$/i,
    async read(url, get, t) {
      let h;
      try { h = (await get(url)).body; } catch (e) {
        if (/blocked/.test(e.message)) throw new Error("Spacelist does not let apps read its pages; open the listing, copy the page and paste the text");
        throw e;
      }
      if (/cf-chl|challenge-platform/i.test(h) && !/<span class="key">/i.test(h))
        throw new Error("Spacelist does not let apps read its pages; open the listing, copy the page and paste the text");
      const kv = {};
      for (const [, k, v] of h.matchAll(/<span class="key">([^<]*)<\/span>\s*<span[^>]*>([^<]*)/gi)) kv[k.trim()] = kv[k.trim()] || t.decode(v).trim();
      // "$21,621/yr"; a monthly figure is made yearly only when the page says /mo. The site's one
      // Taxes figure is taken as the yearly total; it does not say whether school tax is in it.
      const yearly = v => {
        const [n, per] = (v || "").split("/");
        const x = t.money(n);
        return !x ? null : !per || /^\s*y/i.test(per) ? x : /^\s*mo/i.test(per) ? x * 12 : null;
      };
      const title = t.decode((h.match(/<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "").replace(/<[^>]+>/g, "").trim();
      const desc = t.htmlText([...h.matchAll(/<p class="description[^"]*">([\s\S]*?)<\/p>/gi)].map(m => m[1]).join("<br>"));

      const res = count(desc, "r[ée]sidenti\\p{L}*");
      const com = count(desc, "commerci\\p{L}*|retail");
      const total = Number((desc.match(/(?<![\p{L}\d])(\d{1,4})[\s-]*(?:units?|unit[ée]s|logements|apartments|appartements|suites|doors)(?!\p{L})/iu) || [])[1]) || 0;
      // a shop on the ground floor with no stated count leaves the split unknown, so no doors
      const mixed = /\/(?:retail|office|industrial)/i.test(url) || /\b(?:commercial|commerciale?s?|commerciaux|retail|mixed[- ]use)\b/i.test(desc);
      const units = res || com ? { res: res || (total > com ? total - com : 0), com }
        : total && !mixed ? { doors: total } : {};

      // "329 RUE ONTARIO EST, MONTRÉAL, QC, Montréal, QC": provinces and a repeated town go
      const seen = new Set();
      const address = title.split(/\s*,\s*/).filter(p => !/^[A-Z]{2}$/.test(p) && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).join(", ");
      return {
        fields: Object.assign({
          // a price per square foot ("$25/ft²") is no asking price
          price: /\//.test(kv["Asking Price"] || "") ? null : t.money(kv["Asking Price"]),
          taxes: yearly(kv["Taxes"]),
          year: Number(kv["Year Built"]) || null,
          address,
        }, units),
      };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
