// Cushman & Wakefield: the main site (cushmanwakefield.com, Canada and US) and the US Multifamily
// Advisory Group site (multifamily.cushwake.com). Both are plain HTML. The main site has the
// price in its Details list and the address in its JSON-LD, the unit count only in the title
// or overview ("15-Unit ...", "4-Plex"). The Multifamily site shows units but never a price.
(function (L) {
  L.register({
    name: "Cushman & Wakefield",
    hosts: /^cushmanwakefield\.com$|^multifamily\.cushwake\.com$/i,
    async read(url, get, t) {
      const h = (await get(url)).body;
      const strip = s => t.decode((s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
      if (/cushwake\.com$/i.test(new URL(url).hostname)) {
        // "1707 Arrowhead Road<br />North Little Rock, AR&nbsp; 72118"
        const [street, town] = strip((h.match(/<div class="address">([\s\S]*?)<\/div>/i) || [])[1]).split("\n");
        const about = (h.match(/<div id="propertyabout"[\s\S]*?<\/h2>([\s\S]*?)<\/div>/i) || [])[1];
        return {
          text: strip((h.match(/<h1>([\s\S]*?)<\/h1>/i) || [])[1]) + "\n" + t.htmlText(about || ""),
          fields: {
            doors: Number(strip((h.match(/<div class="units">[\s\S]*?class="value">([^<]*)/i) || [])[1]).replace(/\D/g, "")) || 0,
            address: [street, (town || "").split(",")[0]].filter(Boolean).join(", "),
          },
        };
      }
      const dd = id => strip((h.match(new RegExp(`<dt>${id}:</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i")) || [])[1]);
      const ld = t.jsonLd(h).find(o => o.About) || {};
      const offer = ld.About || {};
      const a = (offer.availableAtOrFrom || {}).address || {};
      const overview = (h.match(/<div class="page-content-body">([\s\S]*?)<\/div>/i) || [])[1];
      return {
        text: t.decode(offer.name || "") + "\n" + t.htmlText(overview || ""),
        fields: {
          // "Contact us for pricing" and "Negotiable" are no price. Read by its id, since the
          // French page (/fr-ca/) labels it "Prix de vente"
          price: t.money(strip((h.match(/<dd id="SalePrice"[^>]*>([\s\S]*?)<\/dd>/i) || [])[1])),
          // only the English page has this row; the French one leaves the year to the overview text
          year: Number(dd("Year Built")) || null,
          address: [a.streetAddress, a.addressLocality].filter(Boolean).join(", "),
        },
      };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
