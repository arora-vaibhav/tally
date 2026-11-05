// RE/MAX Canada (remax.ca, residential and /commercial listings outside Quebec): a Next.js page
// that carries the listing as JSON inside its self.__next_f "flight" chunks: price, address,
// annual taxes and year built. Unit counts and income are only in the broker's remarks.
(function (L) {
  // the "listing":{...} object holding propertySubType, cut out by matching its braces
  function listing(flight) {
    for (const m of flight.matchAll(/"listing":\{/g)) {
      let depth = 0, j = m.index + 10;
      for (; j < flight.length; j++) {
        const c = flight[j];
        if (c === '"') { for (j++; flight[j] !== '"'; j++) if (flight[j] === "\\") j++; }
        else if (c === "{") depth++;
        else if (c === "}" && !--depth) break;
      }
      try { const o = JSON.parse(flight.slice(m.index + 10, j + 1)); if ("propertySubType" in o) return o; } catch (e) { /* not this one */ }
    }
    return null;
  }
  // a long text arrives as "$4e", pointing at a row "4e:T<byte length in hex>,<text>"
  function resolve(flight, v) {
    const m = /^\$([0-9a-f]+)$/.exec(v || "");
    if (!m) return v || "";
    const head = new RegExp("(?:^|[^0-9a-f])" + m[1] + ":T([0-9a-f]+),").exec(flight);
    if (!head) return "";
    const enc = new TextEncoder();
    const start = enc.encode(flight.slice(0, head.index + head[0].length)).length;
    return new TextDecoder().decode(enc.encode(flight).slice(start, start + parseInt(head[1], 16)));
  }

  L.register({
    name: "RE/MAX",
    hosts: /(^|\.)remax\.ca$/i,
    async read(url, get, t) {
      const html = (await get(url)).body || "";
      const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(m => JSON.parse(m[1])).join("");
      const x = listing(flight);
      // under load the site answers with a short bot check page instead of the listing
      if (!x) throw new Error("remax.ca did not send the listing (it may be checking for bots); try again in a few minutes, or open the listing, copy the page and paste the text");
      const loc = x.location || {};
      const f = {
        price: x.isRental ? null : t.money(x.listPriceRaw),
        // "333/335 337 PRINCESS STREET" from the full address, then the town
        address: [(loc.listingAddressFull || loc.listingAddress1 || "").split(",")[0], loc.city].filter(Boolean).join(", "),
        taxes: t.money(x.taxAnnualAmount),
        year: x.yearBuilt > 1700 ? x.yearBuilt : null,
      };
      // the sub type ("Triplex") counts the doors for readListing, then the remarks; "residential
      // units" in prose is reworded so readListing does not take the rest of the sentence as the unit mix
      const remarks = resolve(flight, x.publicRemarks).replace(/residential units/gi, "residential dwellings");
      return { text: (x.propertySubType || "") + "\n" + remarks, fields: f };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
