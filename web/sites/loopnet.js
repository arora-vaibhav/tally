// LoopNet (loopnet.com, loopnet.ca): Akamai turns away every request that is not a full
// browser, listing pages and search alike, so an app cannot read it.
(function (L) {
  L.register({
    name: "LoopNet",
    hosts: /(^|\.)loopnet\.(?:com|ca)$/i,
    async read() {
      throw new Error("LoopNet does not let apps read its pages; open the listing, copy the page and paste the text");
    },
  });
})(typeof module === "object" && module.exports ? require("../links.js") : self.TallyLinks);
