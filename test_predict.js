// node test_predict.js : checks what Tally suggests while typing.
const { index, suggest, restAfter } = require("./web/predict.js");

const sheet = [
  "# 403-409 St-Roch, the ask",
  "price = 4,975,000   asking, plus GST/QST",
  "area = 17,240   building square feet",
  "land = 33,300   land square feet",
  "taxes = 69,467 + 1,786   municipal and school tax",
  "need = price * 6.25%   NOI needed at a six and a quarter cap",
  "need / area   net rent per square foot the price needs",
];
const other = [
  "price = 2,150,000   asking",
  "noi = 148,000   broker NOI",
  "noi / price   going-in cap",
  "debt = price * 75%   loan at 75% LTC",
  "debt = price * 75%   loan at 75% LTC",
  "debt = price * 65%   loan at 65% LTC",
];
const here = index(sheet), others = index(other);

const cases = [
  // [typed so far, with other sheets?, expected suggestion]
  ["need = price *", false, " 6.25%   NOI needed at a six and a quarter cap"],
  ["need  =  price * 6", false, ".25%   NOI needed at a six and a quarter cap"],   // spacing does not matter
  ["NEED / ar", false, "ea   net rent per square foot the price needs"],          // nor case
  ["debt = price *", true, " 75%   loan at 75% LTC"],                             // the more common ending wins
  ["debt = price *", false, ""],                                                  // other sheets switched off
  ["x = ar", false, "ea"],                                                        // a name defined in the sheet
  ["x = t", false, "axes"],                                                       // one letter is enough for a name
  ["x = 5 sq", false, "ft"],                                                      // a unit
  ["x = 100 US", false, "D"],                                                     // a currency
  ["x = 3 of", false, ""],                                                        // a complete word is left alone
  ["x = need", false, ""],                                                        // and so is a complete name
  ["x = 4,9", false, "75,000"],                                                   // a number used before
  ["x = 69", false, ",467"],
  ["x = 7", false, ""],                                                           // one digit is too little
  ["x = 2,1", true, "50,000"],                                                    // a number from another sheet
  ["x = 2,1", false, ""],
  ["zz", false, ""],
  ["", false, ""],
  ["   ", false, ""],
];

let fail = 0;
for (const [typed, withOthers, want] of cases) {
  const got = suggest(typed, here, withOthers ? others : null);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${JSON.stringify(typed)}${withOthers ? " (+others)" : ""} -> ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
}

// review fixes: a comma after a number is punctuation, and accented words are whole words
{
  const ix = index(["price = 4,975,000, plus GST", "rents 1,200, 1,350 and 1,400", "building = 5", "Montréal école"]);
  for (const [typed, want] of [["x = 4,9", "75,000"], ["x = 4,975,000", ""], ["x = 1,2", "00"],
                               ["x = Montréb", ""],   // "b" after an accent is not a new word to complete as "building"
                               ["note: Montr", "éal"], ["l'éc", "ole"]]) {
    const got = suggest(typed, ix, null);
    if (got !== want) { fail++; console.log(`FAIL ${JSON.stringify(typed)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${JSON.stringify(typed)} -> ${JSON.stringify(got)}`);
  }
}

for (const [t, c, want] of [["a  b", "a b c", " c"], ["a b ", "a   b   c", "c"], ["ab", "a b", null], ["x", "", null]]) {
  const got = restAfter(t, c);
  if (got !== want) { fail++; console.log(`FAIL restAfter(${JSON.stringify(t)}, ${JSON.stringify(c)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
