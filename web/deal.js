// Tally deals: read a pasted listing (Centris in French or English, or a broker's email or
// PDF text) and build the napkin sheet Fox uses to screen a building, with the listing's
// numbers in it. The sheet is the same one napkin.py writes (Villeray assumptions), every
// line named and wired, so changing one figure moves everything below it.
// Works in the browser (window.TallyDeal) and in Node (module.exports) for tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TallyDeal = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // A money or count figure: "4 975 000 $", "$4,975,000", "1 475 000,50 $", "1.475M", "850k", "63".
  // A decimal followed by k or M is read first, so "$1.475M" is 1,475,000 and not 1,475 million.
  // Thousands may be split by a space, a no-break space, a comma or a period.
  const FIG = String.raw`\$?\s*(?:(\d+[.,]\d+)\s*([kKM])(?![a-z])|(\d{1,3}(?:[ \u00a0\u202f,.]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*([kKM](?![a-z]))?)`;

  function toNumber(f) {
    const [, dec, decMult, whole, cents, mult] = f;
    if (dec) return Number(dec.replace(",", ".")) * (/k/i.test(decMult) ? 1e3 : 1e6);
    let n = Number(whole.replace(/[ \u00a0\u202f,.]/g, ""));
    if (cents) n += Number(cents) / Math.pow(10, cents.length);
    if (mult) n *= /k/i.test(mult) ? 1e3 : 1e6;
    return n;
  }

  // Figures that belong to a label: straight after it on the same line ("Price: $4,975,000",
  // "Taxes<tab>7 939 $", "asking price of $4.9M"), or alone on the next line, which is how a
  // copied Centris page reads. A figure further away is someone else's: in "Tenants pay their
  // own electricity, except units 1 and 7" the 1 is not the electricity bill.
  const NEAR = new RegExp(String.raw`^\s*(?:[:=\-]|of|is|at|de)?\s*` + FIG);
  const ALONE = new RegExp(String.raw`^\s*` + FIG + String.raw`\s*\$?\s*$`);
  function figures(lines, label) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(label);
      if (!m) continue;
      if (/(?:per|par|\/|average|moyen(?:ne)?)\s*$/i.test(lines[i].slice(0, m.index))) continue; // "rent per unit: 1,250" is not a unit count
      const rest = lines[i].slice(m.index + m[0].length);
      const f = rest.match(NEAR) || (!rest.trim() && lines[i + 1] && lines[i + 1].match(ALONE));
      if (f) out.push(toNumber(f));
    }
    return out;
  }
  // first: the first figure at least min. largest: the biggest, because Centris lists each
  // tax and expense per month first and per year second, and the napkin wants the year.
  const first = (lines, label, min, max) => figures(lines, label).find(n => n >= (min || 0) && n <= (max || Infinity)) || null;
  const largest = (lines, label, min) => Math.max(0, ...figures(lines, label).filter(n => n >= (min || 0))) || null;

  const lineAfter = (lines, label) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(label);
      if (m) return (lines[i].slice(m.index + m[0].length).replace(/^[\s:]+/, "") || lines[i + 1] || "").trim();
    }
    return "";
  };

  const ISLAND = /montr[ée]al|westmount|mont-royal|dorval|c[ôo]te-saint-luc|pointe-claire|kirkland|beaconsfield|hampstead|sainte-anne-de-bellevue|verdun|lachine|lasalle|saint-laurent|anjou|outremont|rosemont|villeray|plateau|hochelaga|ahuntsic|parc-extension|notre-dame-de-gr[aâ]ce/i;
  const GREATER = /laval|longueuil|brossard|terrebonne|saint-lambert|boucherville|chambly|saint-bruno|sainte-th[ée]r[èe]se|repentigny|blainville|mascouche|boisbriand|saint-eustache|ch[âa]teauguay|la prairie|candiac|vaudreuil/i;
  const CITY = /qu[ée]bec|l[ée]vis|gatineau|sherbrooke|trois-rivi[èe]res|saint-j[ée]r[ôo]me|drummondville|granby|saint-jean-sur-richelieu|saguenay|joliette|magog|victoriaville/i;

  // readListing pulls what a napkin needs from pasted text. Missing figures are null.
  function readListing(text) {
    const lines = text.replace(/\r/g, "").split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const all = lines.join("\n");
    const L = {};
    L.price = first(lines, /\b(?:prix demand[ée]|prix|asking price|list(?:ing)? price|sale price|price)(?![A-Za-zÀ-ÿ])\s*:?/i, 10000);

    // units: the Centris mix "Résidentiel (6), Commercial (1)" (counted once, from its own line),
    // else "Units: 4" or "a 63-unit building"
    const MIX = /(r[ée]sidenti[ae]l|residential|commerciale?|commercial|bureau|office|entrep[ôo]t|warehouse|industriel|industrial)\s*\((\d+)\)/gi;
    const mixLine = lineAfter(lines, /nombre d[’']unit[ée]s|number of units/i);
    const hasMix = l => /\(\d+\)/.test(l) && new RegExp(MIX.source, "i").test(l); // no shared lastIndex
    const counted = hasMix(mixLine) ? mixLine : (lines.find(hasMix) || "");
    let res = 0, com = 0;
    for (const [, lab, n] of counted.matchAll(MIX)) {
      if (/^r/i.test(lab)) res += Number(n); else com += Number(n);
    }
    if (!(res + com)) {
      // a count is 1 to 2,000; anything bigger next to "units" is a price per unit
      const u = first(lines, /\b(?:nombre d[’']unit[ée]s|number of units|total units|units?|unit[ée]s|logements|doors|suites|apartments|appartements)\b\s*:?/i, 1, 2000)
        || Number((all.match(/\b(\d{1,4})[\s-]*(?:units?|unit[ée]s|logements|doors|suites|apartments|plex)\b/i) || [])[1] || 0);
      const plex = (all.match(/\b(duplex|triplex|quadruplex|fourplex|quintuplex|sixplex)\b/i) || [])[1];
      res = u && u <= 2000 ? u : plex ? { duplex: 2, triplex: 3, quadruplex: 4, fourplex: 4, quintuplex: 5, sixplex: 6 }[plex.toLowerCase()] : 0;
    }
    L.res = res; L.com = com; L.doors = res + com;
    L.unitMix = lineAfter(lines, /unit[ée]s r[ée]sidentielles|residential units/i);

    // potential gross, never effective or net gross income (those already have vacancy taken off)
    L.gross = first(lines, /(?<!(?:effective|net|effectifs?|nets?)\s)\b(?:revenus bruts potentiels|revenus bruts|potential gross (?:revenues?|incomes?|rents?)|gross (?:annual |potential |scheduled )?(?:revenues?|incomes?|rents?)|revenus)\b\s*:?/i, 1000);
    // a tax year may follow a tax label, in brackets or not: "Municipales (2026)", "Property taxes 2025:"
    const YEAR = String.raw`\s*(?:\(?\s*(?:19|20)\d{2}\s*\)?)?\s*:?`;
    // "Municipales (2026)" / "Municipal (2026)", never the assessment ("Évaluation municipale")
    const municipal = largest(lines, new RegExp(String.raw`(?<!valuation\s)\b(?:taxes\s+)?municipa(?:le?s?|l)\b(?!\s+(?:assessment|evaluation|valuation))(?:\s+tax(?:es)?)?` + YEAR, "i"), 50);
    const school = largest(lines, new RegExp(String.raw`\b(?:taxes\s+)?(?:scolaires?|school)\b(?:\s+tax(?:es)?)?` + YEAR, "i"), 10);
    L.taxes = municipal || school ? (municipal || 0) + (school || 0)
      : largest(lines, new RegExp(String.raw`\b(?:real estate taxes|property tax(?:es)?|taxes)\b` + YEAR, "i"), 100);
    L.insurance = largest(lines, /\b(?:assurances?|insurance)\b\s*:?/i, 100);
    let energy = 0;
    // letter lookarounds instead of \b, which does not work next to an accented letter (Électricité)
    // the same rows napkin.py counts as energy: electricity, heating oil, gas, heating, energy
    for (const lab of [/(?<![A-Za-zÀ-ÿ])(?:[ée]lectricit[ée]|electricity|hydro)(?![A-Za-zÀ-ÿ])\s*:?/i,
                       /(?<![A-Za-zÀ-ÿ])(?:chauffage|heating|mazout|gaz(?: naturel)?|natural gas)(?![A-Za-zÀ-ÿ])\s*:?/i,
                       /(?<![A-Za-zÀ-ÿ])(?:[ée]nergie|energy)(?![A-Za-zÀ-ÿ])\s*:?/i]) {
      energy += largest(lines, lab, 50) || 0;
    }
    L.energy = energy || null;
    const y = all.match(/\b(?:ann[ée]e de construction|year built|built(?: in)?|construit en)\b\s*:?\s*\n?\s*((?:18|19|20)\d{2})/i);
    L.year = y ? Number(y[1]) : null;
    const c = all.match(/(?:n[ºo°]\s*centris|centris\s*(?:no\.?|n[ºo°]|#|number)?)\s*:?\s*(\d{7,9})/i);
    L.centris = c ? c[1] : "";

    // address: the line after "... à vendre / for sale", else the first line that reads like one
    let addr = "";
    const forSale = lines.findIndex(l => /(?:à vendre|for sale)$/i.test(l));
    if (forSale >= 0 && lines[forSale + 1] && /\d/.test(lines[forSale + 1])) addr = lines[forSale + 1];
    if (!addr) addr = lines.find(l => /^\d[\d\s,-]*\s*,?\s*(?:rue|avenue|av\.?|boul(?:evard)?\.?|bd|chemin|ch\.?|place|street|st\.?|road|rd\.?|drive|dr\.?|blvd|route|rang|mont[ée]e)\b/i.test(l) && l.length < 120) || "";
    L.address = addr.replace(/\s*\|.*$/, "").trim();
    // the market area comes from the building's own town (the last part of its address); the
    // rest of the text is only a fallback, since a broker's office address names another town
    const area = w => ISLAND.test(w) ? ["Montreal island", 0.05] : GREATER.test(w) ? ["greater Montreal", 0.0525]
      : CITY.test(w) ? ["a regional city", 0.0575] : null;
    const town = L.address.includes(",") ? L.address.split(",").pop() : L.address;
    L.area = area(town) || area(L.address) || area(all.slice(0, 2000)) || ["a small town, or the area is not clear", 0.065];
    // Tally's own lines ("price = 1,475,000") are a sheet, not a listing
    L.isSheet = lines.some(l => /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.test(l));
    return L;
  }

  // A listing becomes a deal sheet only with what the napkin needs, as napkin.py does: a price,
  // the doors and the gross revenue. Anything less (notes that mention a price, a copied
  // sheet) is pasted as it is.
  const looksLikeListing = L => !!(L.price && L.doors && L.gross && !L.isSheet);

  const fmt = n => Math.round(n).toLocaleString("en-US");
  const pct = x => `${Math.round(x * 10000) / 100}%`;

  // dealSheet writes the napkin. With no listing it is the blank template to fill in.
  function dealSheet(L, today) {
    L = L || {};
    const blank = !L.price;
    const res = L.res || 0, com = L.com || 0, doors = L.doors || 0;
    const heavy = com > 0 && com >= res;
    let cap = L.area ? L.area[1] : 0.05;
    if (com) cap += 0.0025;
    if (heavy) cap += 0.005;
    const vac = heavy ? 0.05 : com ? 0.04 : 0.03;
    const [dscr, ltv] = heavy ? [1.3, 0.65] : [1.25, 0.75];
    const title = L.address || (blank ? "New deal" : "Pasted listing");
    const head = [`# ${title}, the ask`];
    if (!blank) {
      head.push(`// ${L.centris ? "Centris " + L.centris + ", read" : "Read"} from a pasted listing${today ? " on " + today : ""}. Check each figure against the listing.`);
      head.push(`// ${res} residential and ${com} commercial units.${L.unitMix ? " " + L.unitMix : ""}${L.year ? " Built " + L.year + "." : ""}`);
    } else {
      head.push("// Fill in the figures that are 0; everything below follows them. Assumptions are the Villeray ones.");
    }
    return [
      ...head,
      L.price ? `price = ${fmt(L.price)}   asking` : "price = 0   asking price",
      doors ? `doors = ${doors}   all units` : "doors = 0   number of units",
      "price / doors   per door",
      L.gross ? `gross = ${fmt(L.gross)}   potential gross revenue` : "gross = 0   potential gross revenue, a year",
      "price / gross   GRM",
      "",
      "# Real NOI, napkin",
      `// Vacancy ${pct(vac)}, management 4%, repairs 1,000 a door, reserve 350 a door, other at least 450 a door.`,
      `vac = gross * ${pct(vac)}   vacancy and bad debt`,
      "egi = gross - vac   effective gross income",
      L.taxes ? `taxes = ${fmt(L.taxes)}   listed taxes` : "taxes = price * 0.9%   taxes, a guess near one percent of price",
      L.insurance ? `insurance = ${fmt(L.insurance)}   listed insurance` :
        com ? `insurance = ${fmt(res * 1000 + com * 2500)}   insurance, a guess by door` : "insurance = doors * 1,000   insurance, a guess by door",
      L.energy ? `energy = ${fmt(L.energy)}   listed energy` : "energy = doors * 600   common energy, a guess by door",
      "other = doors * 450   snow, cleaning, admin, other costs",
      "mgmt = egi * 4%   management",
      "repairs = doors * 1,000   general upkeep",
      "reserve = doors * 350   replacement reserve",
      "opex = taxes + insurance + energy + other + mgmt + repairs + reserve",
      "opex as % of egi   expense ratio",
      "noi = egi - opex   NOI",
      "noi as % of price   cap rate at the ask",
      "",
      "# What it is worth",
      `// Market cap ${pct(cap)} for ${L.area ? L.area[0] : "Montreal island"}${com ? ", with retail in the mix" : ""}. Island 5%, greater Montreal 5.25%, regional city 5.75%, small town 6.5%.`,
      `value = noi / ${pct(cap)}   value at the market cap`,
      "value - price   gap to the ask",
      "",
      "# Debt, conventional",
      `// 4.75% fixed, 25 year amortization, ${dscr}x DSCR, ${pct(ltv)} LTV cap.`,
      "konst = debt constant at 4.75% over 25 years   annual debt constant",
      `ltvloan = price * ${pct(ltv)}   loan at the LTV cap`,
      `dscrloan = max(noi, 0) / ${dscr} / konst   loan the NOI carries`,
      "loan = min(ltvloan, dscrloan)   the smaller one binds",
      "loan as % of price   real LTV",
      "ds = loan * konst   annual debt service",
      "noi - ds   cash flow after debt",
      "",
      "# Cash in",
      "// Welcome tax by price band, closing costs approx 1%.",
      "welcome = price * (price > 2,000,000 ? 2.4% : price > 800,000 ? 1.8% : 1.3%)   welcome tax, approx",
      "equity = price - loan + welcome + price * 1%   cash to close",
      "(noi - ds) as % of equity   cash on cash",
      "",
      "# Price that works",
      `maxprice = max(noi, 0) / ${dscr} / konst / ${pct(ltv)}   both lender tests met`,
      "maxprice - price   vs the ask",
      "",
    ].join("\n");
  }

  return { readListing, looksLikeListing, dealSheet };
});
