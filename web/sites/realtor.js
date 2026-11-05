// Realtor.ca: every page and its API answer an app with a Cloudflare 403 challenge, so Tally
// cannot read a listing there; the person copies the page instead. (The same listing is
// usually on royallepage.ca or remax.ca under its MLS number, which Tally can read.)
(function (L) {
  L.register({
    name: "Realtor.ca",
    hosts: /(^|\.)realtor\.ca$/i,
    async read() {
      throw new Error("Realtor.ca does not let apps read its pages; open the listing, copy the page and paste the text");
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
