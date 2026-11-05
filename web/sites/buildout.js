// Buildout: the listing system behind many brokerage sites (Macdonald Commercial). The broker's
// own page is an empty shell that loads Buildout's plugin, so the reader asks Buildout directly:
// the plugin's listing page for its Property Details table and description, and the plugin's
// inventory feed for the unit count, which only the feed has. Links can be the broker's page
// (macdonaldcommercial.com/properties/<id>/) or Buildout's own (buildout.com/plugins/<token>/<site>/inventory/<id>).
(function (L) {
  L.register({
    name: "Buildout",
    hosts: /^buildout\.com$|^macdonaldcommercial\.com$/i,
    async read(url, get, t) {
      const u = new URL(url);
      let token, site, id;
      const m = u.pathname.match(/\/plugins\/([0-9a-f]+)\/([^/]+)\/inventory\/([^/?#]+)/i);
      if (m) [, token, site, id] = m;
      else {
        // the broker's page carries buildoutConfig = { token: "...", rootPath: "/properties" }
        const h = (await get(url)).body;
        token = (h.match(/buildoutConfig\s*=\s*\{[\s\S]*?token:\s*["']([0-9a-f]+)/i) || [])[1];
        const root = (h.match(/buildoutConfig\s*=\s*\{[\s\S]*?rootPath:\s*["']([^"']+)/i) || [])[1] || "/properties";
        id = u.pathname.startsWith(root + "/") ? u.pathname.slice(root.length + 1).split("/")[0] : "";
        site = u.hostname;
      }
      if (!token || !id) throw new Error("that page is not a Buildout listing; open it, copy the page and paste the text");
      const base = `https://buildout.com/plugins/${token}/`;
      const page = (await get(`${base}${site}/inventory/${id}?pluginId=0&iframe=true&embedded=true`)).body;
      // the listing part only: from the Property Details table to the broker contacts
      const body = (page.match(/Property Details[\s\S]*?(?=Request More Info|<h2[^>]*>\s*Map\b)/i) || [""])[0];
      // the feed is searched by the id's words ("985 broughton street vancouver"), then matched on the id
      const q = id.replace(/-(?:sale|lease)$/i, "").replace(/-/g, " ");
      const feed = JSON.parse((await get(`${base}inventory.json?q=${encodeURIComponent(q)}`)).body || "{}");
      const x = (feed.inventory || []).find(i => (i.show_link || "").replace(/[?#].*$/, "").replace(/\/$/, "").endsWith("/" + id)) || {};
      const attr = Object.fromEntries(x.index_attributes || []);
      // only the Property Details table is read as a listing: the prose gave a land lot a door
      // ("zoning permits up to 6 strata units") and lost the shops of a mixed-use building
      const [table, rest = ""] = t.htmlText(body).split(/\nProperty Description\n/);
      const desc = rest.split(/\n(?:Location Description|Highlights)\n/)[0];
      // "five retail units at grade and five generous-sized residential rental units"
      const count = word => {
        const m = desc.match(new RegExp(`\\b(\\d{1,4}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:[\\w-]+\\s+){0,2}?(?:${word})\\b`, "i"));
        return m ? { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }[m[1].toLowerCase()] || Number(m[1]) : 0;
      };
      const res = count("residential"), com = count("commercial|retail|office");
      const total = parseInt((attr["# of Units"] || "").replace(/,/g, ""), 10) || 0;
      const type = (table.match(/Property Type:\s*(.*)/i) || [])[1] || attr["Property Type"] || "";
      // the feed's count does not say whether it takes in the shops, so a mixed-use building with
      // no stated split, or a land lot, gets no doors
      const units = res || com ? { res: res || (total > com ? total - com : 0), com }
        : /land/i.test(type) || /\b(?:mixed[- ]use|retail|commercial)\b/i.test(desc) ? {} : { doors: total };
      return {
        text: table,
        fields: Object.assign({
          // "$25.00/SF/yr" is a lease rate, not an asking price
          price: /\$/.test(attr.Price || "") && !/\//.test(attr.Price) ? t.money(attr.Price) : null,
          address: x.address ? [x.address, (x.city || "").trim()].filter(Boolean).join(", ") : "",
        }, units),
      };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
