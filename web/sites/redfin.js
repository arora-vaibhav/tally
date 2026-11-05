// Redfin (redfin.com, redfin.ca): listing pages answer an app with 202 and an AWS WAF JavaScript
// challenge, and its stingray API with 403, so there is nothing to read; the person pastes the page.
(function (L) {
  L.register({
    name: "Redfin",
    hosts: /(^|\.)redfin\.(com|ca)$/i,
    async read() {
      throw new Error("Redfin does not let apps read its pages; open the listing, copy the page and paste the text");
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
