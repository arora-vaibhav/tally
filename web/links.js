// Tally links: a listing link pasted into Tally (or shared to it on Android) is fetched by the
// app and read into the same listing deal.js reads from pasted text. Each site has a reader in
// web/sites/ that registers here; a page from any other site is read as text, the way a
// copied page would be.
// A reader gets the link, get (the app's fetch: the page is fetched by Tally itself, not the
// browser, so sites need no CORS) and these tools, and returns { text } for readListing,
// { fields } for fromFields, or both (fields win over what the text gave).
// Works in the browser (window.TallyLinks) and in Node (module.exports) for tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./deal.js"));
  else root.TallyLinks = factory(root.TallyDeal);
})(typeof self !== "undefined" ? self : this, function (Deal) {
  "use strict";

  const sites = [];
  // site: { name, hosts: /regex on the host name/, read: async (url, get, tools) => ({ text?, fields? }) }
  const register = site => { sites.push(site); return site; };
  const siteFor = url => {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return sites.find(s => s.hosts.test(host)) || null;
  };

  // A paste is a link when it is short and holds one web address: the bare link, or what a
  // phone's share button sends ("Look at this listing https://...").
  function findLink(text) {
    const t = (text || "").trim();
    if (!t || t.length > 600 || t.split("\n").length > 4) return "";
    const m = t.match(/\bhttps?:\/\/[^\s<>"']+/gi);
    if (!m || m.length !== 1) return "";
    return m[0].replace(/[).,;!?]+$/, "");
  }

  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", ecirc: "ê",
    agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô", icirc: "î", ucirc: "û", ugrave: "ù", Eacute: "É", frac12: "½", rsquo: "’", ndash: "-", mdash: "-", deg: "°", ordm: "º" };
  const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENT[e] !== undefined ? ENT[e] : m);

  // htmlText turns a page into the text a person would get by selecting it all and copying:
  // one line per block (a label and its value on separate lines, as Centris reads), table
  // cells split by a tab, scripts and styles dropped. Hidden "see more" blocks are kept, since
  // they are in the page even when folded.
  function htmlText(html) {
    return decode(html
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/?(?:t[dh])\b[^>]*>/gi, "\t")
      .replace(/<(?:br|hr)\b[^>]*>|<\/?(?:p|div|li|ul|ol|tr|table|tbody|thead|h[1-6]|dt|dd|dl|section|article|header|footer|main|aside|nav|label|figure|figcaption|button|option|select|form|fieldset|legend|blockquote|pre)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""))
      .split("\n").map(l => l.replace(/[ \t ]+/g, m => (m.includes("\t") ? "\t" : " ")).trim()).filter(l => l && l !== "\t")
      .join("\n");
  }

  // JSON-LD blocks (schema.org), which many listing pages carry: price, address, name.
  function jsonLd(html) {
    const out = [];
    for (const [, body] of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const j = JSON.parse(body.trim());
        const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { out.push(v); if (v["@graph"]) walk(v["@graph"]); } };
        walk(j);
      } catch (e) { /* a broken block is skipped */ }
    }
    return out;
  }
  // meta: <meta property="og:title" content="..."> and friends
  const meta = (html, name) => {
    // the closing quote must match the opening one: an apostrophe inside "..." is text (Bord-de-l'Eau)
    const m = html.match(new RegExp(String.raw`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=(["'])(.*?)\1`, "i"))
      || html.match(new RegExp(String.raw`<meta[^>]+content=(["'])(.*?)\1[^>]*(?:property|name)=["']${name}["']`, "i"));
    return m ? decode(m[2]).trim() : "";
  };
  // money: "$4,975,000", "4 975 000 $", 4975000 -> 4975000; anything else -> null
  const money = v => {
    if (typeof v === "number") return v > 0 ? v : null;
    const s = String(v || "").replace(/[\s  $]|CAD|USD/gi, "").replace(/,(?=\d{3}\b)/g, "").replace(/,(\d{1,2})$/, ".$1");
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? n : null;
  };
  // An address from JSON-LD's PostalAddress, as one line ending in the town.
  const postal = a => !a ? "" : typeof a === "string" ? a
    : [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(", ");

  const tools = { htmlText, jsonLd, meta, money, postal, decode };

  // get with a check: a page that did not load is an error, with the site's status in it.
  const page = get => async (url, opts) => {
    const r = await get(url, opts);
    if (!r || r.status >= 400 || r.status === 0) {
      const why = !r ? "no answer" : r.status === 403 || r.status === 429 ? "the site blocked the request" : "status " + r.status;
      throw new Error(`${new URL(url).hostname} did not send the page (${why})`);
    }
    return r;
  };

  // A page from a site with no reader of its own: its JSON-LD, then its text.
  async function generic(url, get) {
    const r = await get(url);
    if (/pdf/i.test(r.type || "")) throw new Error("that link is a PDF; open it, copy the text and paste it");
    const html = r.body || "";
    const fields = {};
    for (const o of jsonLd(html)) {
      const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
      if (!fields.price && offer && money(offer.price)) fields.price = money(offer.price);
      const addr = postal(o.address || (o.itemOffered && o.itemOffered.address));
      if (!fields.address && addr) fields.address = addr;
    }
    const title = meta(html, "og:title") || ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "");
    return { text: decode(title) + "\n" + htmlText(html), fields };
  }

  // read fetches a link and returns { L, site }: L is the listing (deal.js shape) with url set.
  async function read(url, get) {
    const site = siteFor(url);
    const got = await (site ? site.read(url, page(get), tools) : generic(url, page(get)));
    let L = got.text ? Deal.readListing(got.text) : null;
    const f = got.fields || {};
    if (!L) L = Deal.fromFields(f);
    else if (Object.keys(f).length) {
      // fields win; the text fills what they leave out
      const merged = {};
      for (const k of ["price", "res", "com", "unitMix", "gross", "taxes", "insurance", "energy", "otherListed", "otherRows", "year", "centris", "address"])
        merged[k] = f[k] !== undefined && f[k] !== null && f[k] !== "" ? f[k] : L[k];
      if (f.doors && !f.res && !f.com && !L.doors) merged.res = f.doors;
      L = Deal.fromFields(Object.assign(merged, { areaHint: f.areaHint }));
    }
    L.url = url;
    L.source = site ? site.name : new URL(url).hostname.replace(/^www\./, "");
    return { L, site: L.source };
  }

  return { register, sites, siteFor, findLink, read, tools };
});
