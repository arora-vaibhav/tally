// Colliers (colliers.com, every country and language): Cloudflare answers every request that
// is not a real browser with a challenge page, listings and their API alike, so there is
// nothing an app can read. The user gets told to paste the page instead.
(function (L) {
  L.register({
    name: "Colliers",
    hosts: /(^|\.)colliers\.com$/i,
    async read() {
      throw new Error("Colliers does not let apps read its pages; open the listing, copy the page and paste the text");
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
