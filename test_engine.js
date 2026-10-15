// node test_engine.js : checks the engine against expected answers.
const { evaluateSheet } = require("./web/engine.js");
const cases = [
  ["28 × 1,950 × 12   gross rent", "655,200", "gross rent"],
  ["28 x 1950 x 12", "655,200"],
  ["Gross rent: 28 * 1950", "54,600"],
  ["$1,200 + $300", "1,500"],
  ["5k + 2.5M", "2,505,000"],
  ["20% of 4500", "900"],
  ["4500 + 15%", "5,175"],
  ["100 + 50 + 10%", "165"],
  ["200 - 10%", "180"],
  ["15% off 200", "170"],
  ["15% on 200", "230"],
  ["30 as % of 120", "25%"],
  ["5 km to miles", "3.1069 miles"],
  ["10 / 4", "2.5"],
  ["2 ^ 10", "1,024"],
  ["just a note", null],
  ["sqrt(16)", "4"],
];
let fail = 0;
for (const [line, want, note] of cases) {
  const r = evaluateSheet(line)[0];
  const got = r.kind === "result" ? r.display : null;
  const ok = got === want && (note === undefined || r.note === note);
  if (!ok) fail++;
  console.log((ok ? "ok   " : "FAIL ") + JSON.stringify(line) + " -> " + JSON.stringify(got) + (r.note ? "  note=" + JSON.stringify(r.note) : ""));
}
// currencies, with fixed test rates (1 USD = 1.4 CAD = 0.9 EUR)
{
  const E = require("./web/engine.js");
  E.setRates({ base: "USD", date: "2026-10-14", rates: { CAD: 1.4, EUR: 0.9, GBP: 0.75 } });
  const cur = [
    ["100 USD to CAD", "140.00 CAD"],
    ["140 CAD in USD", "100.00 USD"],
    ["100 usd to cad", "140.00 CAD"],
    ["€90 to USD", "100.00 USD"],
    ["90€ in CAD", "140.00 CAD"],
    ["1,000 CAD + 100 USD", "1,140.00 CAD"],
    ["2.5k CAD x 12  rent", "30,000.00 CAD"],
    ["100 CAD + 15%", "115.00 CAD"],
    ["20% of 500 EUR", "100.00 EUR"],
    ["try harder", null],
  ];
  for (const [line, want] of cur) {
    const r = E.evaluateSheet(line)[0];
    const got = r.kind === "result" ? r.display : null;
    const ok = got === want;
    if (!ok) fail++;
    console.log((ok ? "ok   " : "FAIL ") + JSON.stringify(line) + " -> " + JSON.stringify(got));
  }
  const t = E.evaluateSheet("1,000 CAD\n100 USD\ntotal").map(r => r.display);
  const ok = t[2] === "1,140.00 CAD";
  if (!ok) fail++;
  console.log((ok ? "ok   " : "FAIL ") + "currency total -> " + JSON.stringify(t));
}
// unknown names are reported, prose is not
{
  const kinds = s => evaluateSheet(s).map(r => r.kind === "unknown" ? "unknown:" + r.names.join(",") : r.kind === "result" ? r.display : r.kind);
  const checks = [
    ["95%\nocc * prev", ["0.95", "unknown:occ"]],
    ["occ = 95%\nocc * 100", ["0.95", "95"]],
    ["rent x 12", ["unknown:rent"]],
    ["Call the bank - tomorrow", ["note"]],
    ["just a note", ["note"]],
    ["sqrt(16) + pi * 0", ["4"]],
    ["total = a + b", ["unknown:a,b"]],
    ["4,500 + 15% tip", ["5,175"]],
    ["1850 rent - estimated", ["1,850"]],
    ["95% occ", ["0.95"]],
  ];
  for (const [src, want] of checks) {
    const got = kinds(src);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log((ok ? "ok   " : "FAIL ") + JSON.stringify(src) + " -> " + JSON.stringify(got));
  }
}
// "x" as times after a word, not only after a digit (the bug in the first build)
{
  const r = evaluateSheet("100\nprev x 0.95   less vacancy\nnoi = prev x 0.5\nnoi x 2").map(r => r.display);
  const ok = JSON.stringify(r) === JSON.stringify(["100", "95", "47.5", "95"]);
  if (!ok) fail++;
  console.log((ok ? "ok   " : "FAIL ") + "prev x / name x -> " + JSON.stringify(r));
}
// multi-line: prev, named results, total, headings, comments
const sheet = `# Deal walk-through
28 × 1,956 × 12   gross rent
prev × 0.95   less vacancy
noi = prev × 0.62   NOI
noi / 0.055   value at 5.5 cap

100
200 // with a comment
total`;
const res = evaluateSheet(sheet).map(r => r.kind === "result" ? r.display : r.kind);
const want = ["heading", "657,216", "624,355.2", "387,100.22", "7,038,185.89", "blank", "100", "200", "300"];
const ok = JSON.stringify(res) === JSON.stringify(want);
if (!ok) fail++;
console.log((ok ? "ok   " : "FAIL ") + "sheet -> " + JSON.stringify(res));
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
