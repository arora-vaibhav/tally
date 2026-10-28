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
// Loans, checked against a month-by-month amortisation rather than the closed-form maths.
{
  const amortise = (loan, rate, years, perYear, months) => {
    const i = Math.pow(1 + rate / perYear, perYear / 12) - 1;
    let lo = 0, hi = loan; // find the payment that clears the loan in years*12 months
    for (let k = 0; k < 200; k++) {
      const p = (lo + hi) / 2;
      let b = loan;
      for (let m = 0; m < years * 12; m++) b = b * (1 + i) - p;
      if (b > 0) lo = p; else hi = p;
    }
    let b = loan;
    for (let m = 0; m < months; m++) b = b * (1 + i) - lo;
    return { pay: lo, bal: b };
  };
  const num = s => Number(String(s).replace(/[,%]/g, ""));
  const sheet = [
    "debt = 3,731,250",
    "debt at 4.75% over 25 years",
    "debt at 4.75% over 25 years compounded semi-annually",
    "debt at 4.75% over 25 years balance after 10 years",
    "debt at 4.75 over 300 months",
    "debt at 4.75% interest only",
    "k = debt constant at 4.75% over 25 years",
    "385,913 at 1.25 DSCR, 4.75% over 25 years   max loan",
    "noi = 385,913",
    "noi at 1.25x dscr at 4.75% over 25 years",
    "noi / 1.25 / k",
    "pmt = 1M at 6% over 30 years",
    "pmt * 12",
  ].join("\n");
  const r = evaluateSheet(sheet).map(x => x.kind === "result" ? x : { display: x.kind });
  const us = amortise(3731250, 0.0475, 25, 12, 120), ca = amortise(3731250, 0.0475, 25, 2, 0);
  const checks = [
    ["monthly payment", num(r[1].display), us.pay],
    ["Canadian semi-annual payment", num(r[2].display), ca.pay],
    ["balance after 10 years", num(r[3].display), us.bal],
    ["300 months is 25 years", num(r[4].display), us.pay],
    ["interest only", num(r[5].display), 3731250 * 0.0475 / 12],
    ["debt constant shown as a percent", num(r[6].display), 6.84],
    ["DSCR sizing", num(r[7].display), 385913 / 1.25 / (12 * amortise(1, 0.0475, 25, 12, 0).pay)],
    ["DSCR sizing with names and 1.25x", num(r[9].display), num(r[7].display)],
    ["a named constant stays a fraction", num(r[10].display), num(r[7].display)],
    ["named payment reused", num(r[12].display), 12 * amortise(1e6, 0.06, 30, 12, 0).pay],
  ];
  for (const [what, got, want] of checks) {
    const ok = Math.abs(got - want) <= Math.max(0.01, Math.abs(want) * 1e-6) || (what.includes("percent") && Math.abs(got - want) < 0.005);
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} loan: ${what}: ${got}${ok ? "" : "  want " + want}`);
  }
  if (r[7].note !== "max loan") { fail++; console.log("FAIL loan: a note after a loan phrase should stay a note"); }
  // review fixes for 1.5: each line with the answer it must give
  const ui = s => evaluateSheet(s).map(x => x.kind === "result" ? x.display : x.kind === "unknown" ? "? " + x.names.join(",") : x.kind);
  const last = s => ui(s).pop();
  const D = "debt = 3,731,250\n";
  for (const [sheet, want] of [
    [D + "interest = 14,000\ndebt at 4.75% interest only", "14,769.53"],          // a sheet's own "interest" does not hide the maths
    [D + "payment = 100\ndebt at 4.75% over 25 years", "21,272.5"],
    [D + "balance = 100\ndebt at 4.75% over 25 years balance after 10 years", "2,734,845.87"],
    ["3.2M at 4.75% over 25 years interest only", "12,666.67"],                  // a term does not turn interest-only into P&I
    [D + "debt at 4.75% over 25 years compounded semi annually", "21,173.19"],
    [D + "debt at 4.75% over 25 years compounded semi-annual", "21,173.19"],
    [D + "debt at 4.75% over 25 years compounded fortnightly", "note"],         // no answer beats a wrong one
    [D + "debt at 4.75% interest only compounded semi-annually", "14,625.46"],
    [D + "debt at 4.75% over 25 years balance after 10", "2,734,845.87"],
    [D + "debt at 4.75% over 25 years balance in 10 years", "2,734,845.87"],
    [D + "debt at 4.75% over 25 years balance after 30 years", "0"],
    [D + "debt at 4.75% amortized over 25 years", "21,272.5"],
    ["1M at 0.5 over 25 years", "3,546.7"],                                      // a bare rate is a percent, even under 1
    ["noi = 385,913\nnoi at 1.25 x DSCR, 4.75% over 25 years", "4,512,673.19"],
    ["4M - 10% at 5% over 25 years", "21,045.24"],                               // percent maths inside the amount
    ["4M + 10% at 5% interest only", "18,333.33"],
    ["balance * 1.05\nbalance = 10", "10"],
  ]) {
    const got = last(sheet), ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} loan: ${JSON.stringify(sheet.split("\n").pop())} -> ${got}${ok ? "" : "  want " + want}`);
  }
  if (ui("balance * 1.05\nbalance = 10")[0] !== "? balance") { fail++; console.log("FAIL loan: an undefined 'balance' should still get the ? hint"); }

  // the napkin sheets' hard-coded debt constant at 4.75% over 25 years
  if (Math.abs(12 * amortise(1, 0.0475, 25, 12, 0).pay - 0.06842) > 0.00005) { fail++; console.log("FAIL loan: monthly compounding should match the 0.06842 debt constant"); }
}

console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
