// Centris (centris.ca, French or English): the listing page carries the whole financial block,
// folded under "Voir plus", so its text reads like a page copied after clicking it.
(function (L) {
  L.register({
    name: "Centris",
    hosts: /(^|\.)centris\.ca$/i,
    async read(url, get, t) {
      const r = await get(url);
      return { text: t.htmlText(r.body) };
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
