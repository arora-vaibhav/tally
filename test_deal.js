// node test_deal.js : reading pasted listings, and the deal sheet built from them.
const { readListing, looksLikeListing, dealSheet } = require("./web/deal.js");
const { evaluateSheet } = require("./web/engine.js");
let fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

// A Centris page copied in French: labels with the value on the next line, then the
// financial block, which lists each figure per month first and per year second.
const centrisFr = `Immeuble à revenus à vendre
3857, Rue Prieur Est, Montréal (Montréal-Nord)
1 475 000 $
Utilisation de la propriété
Résidentielle
Année de construction
1961
Superficie habitable
5 795 pc
Nombre d’unités
Résidentiel (7)
Unités résidentielles
7 x 4 ½
Revenus bruts potentiels
96 624 $
Prix
1 475 000 $
Description
Les locataires paient leur électricité, sauf les espaces communs, les logements 1 et 7.
Nº Centris  10052953
Détails financiers
ÉVALUATION MUNICIPALE (2026)
Terrain	303 100 $
Bâtiment	733 100 $
Total	1 036 200 $
Taxes
Municipales (2026)
596 $
Scolaires (2026)
66 $
Total
662 $
Municipales (2026)
7 152 $
Scolaires (2026)
787 $
Total
7 939 $
Dépenses
Électricité
199 $
Assurances
613 $
Électricité
2 393 $
Assurances
7 356 $`;

const centrisEn = `Income properties for sale
3857, Rue Prieur Est, Montréal (Montréal-Nord)
$1,475,000
Year built
1961
Number of units
Residential (7)
Residential units
7 x 4 ½
Potential gross revenue
$96,624
Price
$1,475,000
Description
Tenants pay their own electricity, except common areas, units 1 and 7.
Centris No.  10052953
Municipal assessment (2026)
Total	$1,036,200
Taxes
Municipal (2026)
$596
School (2026)
$66
Municipal (2026)
$7,152
School (2026)
$787
Expenses
Electricity
$199
Insurance
$613
Electricity
$2,393
Insurance
$7,356`;

const want = { price: 1475000, doors: 7, res: 7, com: 0, gross: 96624, taxes: 7939, insurance: 7356, energy: 2393,
  year: 1961, centris: "10052953", address: "3857, Rue Prieur Est, Montréal (Montréal-Nord)", area: "Montreal island" };
for (const [lang, text] of [["French", centrisFr], ["English", centrisEn]]) {
  const L = readListing(text);
  for (const k of Object.keys(want)) check(`${lang} Centris ${k}`, k === "area" ? L.area[0] : L[k], want[k]);
  check(`${lang} unit mix`, L.unitMix, "7 x 4 ½");
}

// The sheet built from it must give what napkin.py gave for this listing on 2026-10-20.
{
  const sheet = dealSheet(readListing(centrisFr), "28 Oct 2026");
  const lines = sheet.split("\n"), res = evaluateSheet(sheet);
  const val = name => {
    const i = lines.findIndex(l => l.startsWith(name + " = "));
    return i >= 0 && res[i].kind === "result" ? Math.round(Number(res[i].value)) : null;
  };
  for (const [name, napkin] of [["noi", 59688], ["value", 1193765], ["loan", 697965], ["maxprice", 930620], ["equity", 818335]]) {
    const got = val(name), ok = got !== null && Math.abs(got - napkin) <= 1;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} sheet ${name}: ${got}${ok ? "" : "  napkin.py gave " + napkin}`);
  }
  check("every calculation line has an answer", lines.filter((l, i) => /\S/.test(l) && !/^\s*(#|\/\/)/.test(l) && res[i].kind !== "result").length, 0);
}

// Centris 12761853, an all-commercial Sherbrooke building, copied with its financial block open:
// water is a tax, snow/garbage/lawn are "other", and the sheet must match napkin.py exactly.
const galt = `Immeuble à revenus à vendre
1009Z - 1011Z, Rue Galt Ouest, Sherbrooke (Les Nations)
995 000 $
+ TPS/TVQ
Année de construction
1950
Nombre d’unités
Commercial (1), Bureau (2)
Revenus bruts potentiels
134 040 $
Prix
995 000 $
Description
Immeuble commercial avec 3 locaux entièrement occupés et des revenus bruts de 134 639$/année.
Nº Centris  12761853
Détails financiers
ÉVALUATION MUNICIPALE (2026)
Terrain	512 300 $
Bâtiment	88 700 $
Total	601 000 $
Par année
Par mois
Taxes
Municipales (2026)
1 016 $
Scolaires (2025)
35 $
Eau (2026)
14 $
Total
1 065 $
Municipales (2026)
12 197 $
Scolaires (2025)
421 $
Eau (2026)
165 $
Total
12 783 $
Dépenses
Électricité
1 194 $
Gaz
750 $
Déneigement
292 $
Ordures
260 $
Pelouse
60 $
Total
2 556 $
Électricité
14 331 $
Gaz
9 001 $
Déneigement
3 501 $
Ordures
3 118 $
Pelouse
719 $
Total
30 670 $
Voir plus
Localisation`;
{
  const L = readListing(galt);
  check("Galt taxes include water", L.taxes, 12783);
  check("Galt energy is electricity and gas", L.energy, 23332);
  check("Galt other listed expenses", L.otherListed, 7338);
  check("Galt is all commercial", [L.res, L.com], [0, 3]);
  check("Galt is a regional city", L.area[0], "a regional city");
  const sheet = dealSheet(L), lines = sheet.split("\n"), res = evaluateSheet(sheet);
  for (const [name, napkin] of [["noi", 67241], ["value", 1034484], ["loan", 646750], ["maxprice", 1163148], ["equity", 376110]]) {
    const i = lines.findIndex(l => l.startsWith(name + " = ")), got = Math.round(Number(res[i].value)), ok = Math.abs(got - napkin) <= 1;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} Galt sheet ${name}: ${got}${ok ? "" : "  napkin.py gave " + napkin}`);
  }
  // the same page copied without opening "Voir plus": no taxes or expenses, and the sheet says so
  const bare = readListing(galt.slice(0, galt.indexOf("Par année")) + "Voir plus\nLocalisation");
  check("Galt without the financial block is flagged", bare.missingFinance, true);
  check("and the sheet says to open Voir plus", /click Voir plus/.test(dealSheet(bare)), true);
  check("a full paste is not flagged", L.missingFinance, false);
}

// A broker email, in the style of the KW St-Roch listing.
{
  const L = readListing(`403-409 Rue St-Roch, Montréal
KW listing, Oct 2026. Industrial flex, built 1989, near the 40 and Parc metro.
Asking price: $4,975,000 plus GST/QST
Four units, three occupied. 4 units total.
Municipal taxes: $69,467
School taxes: $1,786`);
  check("email price", L.price, 4975000);
  check("email taxes", L.taxes, 71253);
  check("email doors", L.doors, 4);
  check("email address", L.address, "403-409 Rue St-Roch, Montréal");
  check("email built", L.year, 1989);
  // no rent figure, so like napkin.py it is not screened: it pastes as text
  check("email without gross is not a deal", looksLikeListing(L), false);
  check("email with gross is a deal", looksLikeListing(readListing("403-409 Rue St-Roch, Montréal\nAsking price: $4,975,000\n4 units\nGross income: $310,000")), true);
}

// review fixes for 1.6: each pasted text and what must be read from it
{
  const r = readListing;
  check("$1.475M is a million and a half", r("Offering price: $1.475M\nTotal units: 12\nGross potential rent: $180,000").price, 1475000);
  check("rent per unit is not doors", r("Asking price: $3,200,000\nAverage rent per unit: $1,250\nTotal units: 24\nGross potential rent: $360,000").doors, 24);
  check("price per unit before total units", r("Asking price: $3,200,000\nPrice per unit: $206,250\nTotal units: 24\nGross income: $400,000").doors, 24);
  check("a tax year is not the tax", r("Asking price: $3,200,000\n24 units\nProperty taxes 2025: $38,400\nGross income: $400,000").taxes, 38400);
  check("a bracketed tax year", r("Asking price: $3,200,000\n24 units\nTaxes (2025): $38,400\nGross income: $400,000").taxes, 38400);
  check("municipal taxes with a year", r("Asking price: $3,200,000\n24 units\nMunicipal taxes 2025: 2 000 $\nGross income: $400,000").taxes, 2000);
  check("gross revenues, plural", r("Asking price: $3,200,000\n24 units\nGross Revenues: $410,000").gross, 410000);
  check("gross annual income", r("Asking price: $3,200,000\n24 units\nGross annual income: $410,000").gross, 410000);
  check("effective gross is not potential gross", r("Asking price: $3,200,000\n24 units\nEffective gross income: $380,000\nGross potential rent: $400,000").gross, 400000);
  check("triplex in words", r("Triplex à vendre\n1234, Rue Fabre, Montréal\n899 000 $\nPrix\n899 000 $\nRevenus bruts potentiels\n42 000 $").doors, 3);
  check("a copied Tally sheet is not a listing", looksLikeListing(r("# Prieur, the ask\nprice = 1,475,000   asking\ndoors = 7   all units\ngross = 96,624   rents")), false);
  check("notes are not a listing", looksLikeListing(r("Meeting notes 28 Oct\nTommy: Prieur price is 1,475,000, 7 units, offer 1.3M?\nCall broker Tuesday")), false);
  const granby = "Immeuble à revenus à vendre\n120, rue Principale, Granby\nPrix\n1 200 000 $\nNombre d’unités\nRésidentiel (8)\nRevenus bruts potentiels\n110 000 $\nDépenses\nGaz\n4 800 $\nÉnergie\n2 000 $\nRE/MAX Agence, 5000 rue Sherbrooke, Montréal";
  check("the town in the address sets the cap", r(granby).area[0], "a regional city");
  check("gas and energy rows count as energy", r(granby).energy, 6800);
}

// a sheet with no doors or gross yet: ratios show no answer rather than the price itself,
// and a negative NOI never sizes a negative loan
{
  const blank = dealSheet(null).replace("price = 0   asking price", "price = 1,150,000").replace("doors = 0   number of units", "doors = 3");
  const lines = blank.split("\n"), res = evaluateSheet(blank);
  const at = start => res[lines.findIndex(l => l.startsWith(start))];
  check("price / gross with no gross has no answer", at("price / gross").kind, "note");
  check("loan from a negative NOI is 0", Number(at("loan = ").value), 0);
  check("price that works from a negative NOI is 0", Number(at("maxprice = ").value), 0);
}

// Things that are not listings stay ordinary pastes.
for (const text of ["28 x 1,950 x 12   gross rent\nprev x 0.95", "Meeting notes\nCall Matt about the price on Tuesday", "price = 4,975,000"]) {
  check(`not a listing: ${JSON.stringify(text.slice(0, 30))}`, looksLikeListing(readListing(text)), false);
}

// a label ending in an accented letter
check("Prix demandé", readListing("Prix demandé : 4 975 000 $\n12 logements\nRevenus bruts : 310 000 $").price, 4975000);

// "price per unit" is not a unit count.
check("price per unit is not doors", readListing("Asking price: $2,500,000\nPrice per unit: $78,968\nGross income: $210,000").doors, 0);

// The blank template: every line parses, and once the three inputs are typed it answers everywhere.
{
  const blank = dealSheet(null);
  check("template starts as a new deal", blank.split("\n")[0], "# New deal, the ask");
  const filled = blank.replace("price = 0   asking price", "price = 1,475,000").replace("doors = 0   number of units", "doors = 7")
    .replace("gross = 0   potential gross revenue, a year", "gross = 96,624");
  const lines = filled.split("\n"), res = evaluateSheet(filled);
  check("filled template answers every line", lines.filter((l, i) => /\S/.test(l) && !/^\s*(#|\/\/)/.test(l) && res[i].kind !== "result").length, 0);
}

console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
