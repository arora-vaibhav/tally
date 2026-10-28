// Tally engine: turns a sheet of text into one result per line.
//
// A line is a calculation with an optional note. Supported, Numi style:
//   28 x 1,950 x 12  gross rent     trailing words are a note
//   rent = 28 * 1950                 names a result for later lines
//   Rent: 28 * 1950                  a label before a colon is ignored
//   # Heading                        a heading, no result
//   // comment                       anything after // is ignored
//   prev / pr / ans                  the previous answer
//   total / sum                      sum of the answers above, up to the last blank line or heading
//   5k, 2.5M, 1.2B                   thousands, millions, billions
//   20% of 4500, 4500 + 15%, 4500 - 10%, 15% off 200, 15% on 200, 30 as % of 120
//   5 km to miles, 3 ft in cm        unit conversion (math.js units)
//   3.2M at 4.75% over 25 years      loan payment; also balance after, interest only, DSCR sizing
//
// Works in the browser (window.TallyEngine) and in Node (module.exports) for tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./math.js"));
  else root.TallyEngine = factory(root.math);
})(typeof self !== "undefined" ? self : this, function (math) {
  "use strict";

  const NUM = String.raw`\d+(?:\.\d+)?`;

  // ---- currencies ------------------------------------------------------
  // Rates arrive as {base: "USD", date, rates: {CAD: 1.42, ...}} (units of each currency per 1 base).
  // Each code becomes a math.js unit, so "100 USD to CAD", "2,500 CAD + 300 USD" and totals just work.
  const CURRENCIES = new Set();
  let ratesInfo = null;
  const SYMBOLS = { "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };

  function setRates(data) {
    if (!data || !data.base || !data.rates) return;
    const base = String(data.base).toUpperCase();
    math.createUnit(base, { override: true });
    CURRENCIES.add(base);
    for (const [code, rate] of Object.entries(data.rates)) {
      const c = code.toUpperCase();
      if (c === base || !(rate > 0)) continue;
      math.createUnit(c, { definition: `${1 / rate} ${base}`, override: true });
      CURRENCIES.add(c);
    }
    ratesInfo = { base, date: data.date || "", count: CURRENCIES.size };
  }

  function currencyWords(s) {
    if (!CURRENCIES.size) return s;
    s = s.replace(/([€£¥₹])\s*(\d[\d,]*(?:\.\d+)?)/g, (_, sym, n) => `${n} ${SYMBOLS[sym]}`)
         .replace(/(\d[\d,]*(?:\.\d+)?)\s*([€£¥₹])/g, (_, n, sym) => `${n} ${SYMBOLS[sym]}`);
    // lowercase codes only right after a number or after to/in, so a note word like "try" is left alone
    return s.replace(/(\d\s*|\b(?:to|in)\s+)([a-z]{3})\b/g, (m, lead, code) =>
      CURRENCIES.has(code.toUpperCase()) ? lead + code.toUpperCase() : m);
  }

  function isCurrency(v) {
    return v && v.isUnit && v.units.length === 1 && v.units[0].power === 1 && CURRENCIES.has(v.units[0].unit.name);
  }

  function normalise(s) {
    return currencyWords(s)
      .replace(/[×✕]/g, "*")
      .replace(/(\d)\s*x\s*(?=[\d(.$])/g, "$1 * ")     // 28 x 1950, 28x1950
      .replace(/([\w).%])\s+x\s+(?=[\w(.$])/g, "$1 * ") // prev x 0.95, rent x 12
      .replace(/÷/g, "/")
      .replace(/[−–]/g, "-")
      .replace(/\$\s*(?=[\d.])/g, "")                    // $1,200 -> 1,200
      .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, m => m.replace(/,/g, ""))
      .replace(new RegExp(`(${NUM})\\s*([kKMB])\\b`, "g"), (_, n, s2) =>
        `(${n} * ${s2.toLowerCase() === "k" ? "1e3" : s2 === "M" ? "1e6" : "1e9"})`);
  }

  // Percent phrases, rewritten into plain math. Returns {expr, asPercent}.
  function percentages(e) {
    let m;
    if ((m = e.match(/^(.+?)\s+as\s+%\s+of\s+(.+)$/i))) {
      return { expr: `(${m[1]}) / (${m[2]}) * 100`, asPercent: true };
    }
    if ((m = e.match(/^(.+?)\s+as\s+%$/i))) return { expr: `(${m[1]}) * 100`, asPercent: true };
    e = e.replace(new RegExp(`(${NUM})\\s*%\\s+of\\s+`, "gi"), "($1 / 100) * ");
    e = e.replace(new RegExp(`(${NUM})\\s*%\\s+off\\s+(.+)$`, "i"), "($2) * (1 - $1 / 100)");
    e = e.replace(new RegExp(`(${NUM})\\s*%\\s+on\\s+(.+)$`, "i"), "($2) * (1 + $1 / 100)");
    // "a + b + 10%" applies to everything before it, the way Numi does.
    if ((m = e.match(new RegExp(`^(.+?)\\s*([+-])\\s*(${NUM})\\s*%$`)))) {
      e = `(${m[1]}) * (1 ${m[2]} ${m[3]} / 100)`;
    }
    e = e.replace(new RegExp(`(${NUM})\\s*%`, "g"), "($1 / 100)");
    return { expr: e, asPercent: false };
  }

  // ---- loans -----------------------------------------------------------
  // Monthly payments with monthly compounding by default, which is what every Fox napkin
  // sheet has used (4.75% over 25 years gives the 0.06842 debt constant). Canadian fixed-rate
  // terms compound semi-annually: end the line with "compounded semi-annually" (also
  // annually, quarterly, monthly).
  // The phrase rewrites call these under private names, so a sheet can still use "payment",
  // "balance" or "interest" as its own names.
  const annual = rate => Number(rate) >= 1 ? Number(rate) / 100 : Number(rate); // a named 4.75 still means 4.75%
  function monthlyRate(rate, perYear) {
    const k = Number(perYear) || 12;
    return Math.pow(1 + annual(rate) / k, k / 12) - 1;
  }
  function pay(loan, rate, years, perYear) {
    const i = monthlyRate(rate, perYear), n = Number(years) * 12;
    return i === 0 ? loan / n : loan * i / (1 - Math.pow(1 + i, -n));
  }
  function bal(loan, rate, years, after, perYear) {
    const i = monthlyRate(rate, perYear), n = Number(years) * 12;
    const m = Number(after) * 12;
    if (m >= n) return 0;                        // past the end of the amortisation, nothing is owed
    const p = pay(loan, rate, years, perYear);
    return i === 0 ? loan - p * m : loan * Math.pow(1 + i, m) - p * (Math.pow(1 + i, m) - 1) / i;
  }
  const debtConstant = (rate, years, perYear) => 12 * pay(1, rate, years, perYear);
  // An amount in a currency ("3M CAD") gives its answer in that currency.
  const money = f => (amount, ...rest) => {
    if (amount && amount.isUnit) {
      const u = amount.formatUnits();
      return math.unit(f(amount.toNumber(u), ...rest), u);
    }
    return f(Number(amount), ...rest);
  };
  math.import({
    __loanPay: money(pay),
    __loanBalance: money(bal),
    __loanInterest: money((loan, rate, perYear) => loan * monthlyRate(rate, perYear)),
    __loanMax: money((noi, dscr, rate, years, perYear) => noi / Number(dscr) / debtConstant(rate, years, perYear)),
    __loanConstant: debtConstant,
  }, { override: true });

  // Loan phrases, rewritten into the functions above. Returns {expr, asPercent}, {bad: true}
  // for a phrase that cannot be right (an unknown compounding), or null for anything else.
  //   3.2M at 4.75% over 25 years                        monthly payment
  //   3.2M at 4.75% over 25 years balance after 10 years  balance left at renewal
  //   3.2M at 4.75% interest only                        monthly interest
  //   385,913 at 1.25 DSCR, 4.75% over 25 years          the largest loan that NOI carries
  //   debt constant at 4.75% over 25 years               yearly payment per dollar borrowed, as %
  // Any can be named (pmt = debt at 4.75% over 25 years). Amounts can be names, sums or
  // currencies (price - 10%, 3M CAD); a rate typed without % is still a percent (at 0.5 = 0.5%).
  const TERM = String.raw`(.+?)\s*(years?|yrs?|y|months?)?`;
  const perYear = w => /semi/i.test(w) ? 2 : /annual|yearly/i.test(w) ? 1 : /quarter/i.test(w) ? 4 : 12;
  function loanPhrase(head) {
    let m, name = "", k = "";
    if ((m = head.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/))) { name = m[1] + " = "; head = m[2]; }
    if ((m = head.match(/^(.*?)\s*,?\s+compounded\s+(semi[\s-]?annual(?:ly)?|annual(?:ly)?|yearly|quarterly|monthly)$/i))) {
      k = ", " + perYear(m[2]);
      head = m[1];
    } else if (/\scompounded\s+\S+$/i.test(head)) {
      return { bad: true }; // "compounded weekly": better no answer than a monthly one
    }
    const arg = a => `(${percentages(a.trim()).expr})`;                  // percent phrases inside an amount
    const rate = r => /^\s*\d+(?:\.\d+)?\s*$/.test(r) ? `(${r.trim()} / 100)` : arg(r);
    const yrs = (n, unit) => /^m/i.test(unit || "") ? `(${arg(n)} / 12)` : arg(n);
    let expr = null, asPercent = false;
    if ((m = head.match(new RegExp(String.raw`^(?:debt\s+)?constant\s+(?:at\s+)?(.+?)\s+(?:amorti[sz]ed\s+)?over\s+` + TERM + "$", "i")))) {
      expr = `__loanConstant(${rate(m[1])}, ${yrs(m[2], m[3])}${k})`; asPercent = "fraction";
    } else if ((m = head.match(new RegExp(String.raw`^(.+?)\s+at\s+(.+?)\s*(?:x|\*)?\s*dscr\s*,?\s*(?:at\s+)?(.+?)\s+(?:amorti[sz]ed\s+)?over\s+` + TERM + "$", "i")))) {
      expr = `__loanMax(${arg(m[1])}, ${arg(m[2])}, ${rate(m[3])}, ${yrs(m[4], m[5])}${k})`;
    } else if ((m = head.match(new RegExp(String.raw`^(.+?)\s+at\s+(.+?)\s+(?:amorti[sz]ed\s+)?over\s+(.+?)\s*(years?|yrs?|y|months?)?\s*,?\s+balance\s+(?:after|in)\s+` + TERM + "$", "i")))) {
      expr = `__loanBalance(${arg(m[1])}, ${rate(m[2])}, ${yrs(m[3], m[4])}, ${yrs(m[5], m[6])}${k})`;
    } else if ((m = head.match(new RegExp(String.raw`^(.+?)\s+at\s+(.+?)(?:\s+(?:amorti[sz]ed\s+)?over\s+.+?)?\s+interest[\s-]+only$`, "i")))) {
      expr = `__loanInterest(${arg(m[1])}, ${rate(m[2])}${k})`;  // a term, if given, does not change interest-only
    } else if ((m = head.match(new RegExp(String.raw`^(.+?)\s+at\s+(.+?)\s+(?:amorti[sz]ed\s+)?over\s+` + TERM + "$", "i")))) {
      expr = `__loanPay(${arg(m[1])}, ${rate(m[2])}, ${yrs(m[3], m[4])}${k})`;
    }
    return expr && { expr: name + expr, asPercent };
  }

  function stripLabel(s) {
    // "Gross rent: 28 * 1950" -> "28 * 1950"; leaves "a:b" ratios alone.
    const m = s.match(/^\s*([A-Za-z][A-Za-z0-9 _'()-]{0,40}):\s+(.+)$/);
    return m ? m[2] : s;
  }

  const NO_ANSWER = {};
  function tryEval(expr, scope) {
    try {
      const node = math.parse(expr);
      // A bare word that is not a known variable is a note, not a result.
      if (node.type === "SymbolNode" && !(node.name in scope)) return undefined;
      const v = node.evaluate(scope);
      if (typeof v === "function" || v === undefined || v === null) return undefined;
      if (typeof v === "number" && !isFinite(v)) return NO_ANSWER; // 5 / 0: a sum with no answer, not a note
      if (v && v.isResultSet) return v.entries.length ? v.entries[v.entries.length - 1] : undefined;
      return v;
    } catch (e) {
      return undefined;
    }
  }

  // Evaluate the longest leading run of words that parses; the rest is a note.
  function evalWithNote(src, scope) {
    const words = src.split(/(\s+)/);
    for (let end = words.length; end > 0; end--) {
      const head = words.slice(0, end).join("").trim();
      if (!head || !/[\d)a-zA-Z_]/.test(head)) continue;
      // "debt at" is never a sum; math.js would read it as debt times a unit called "at"
      if (/\sat$/i.test(head)) continue;
      const loan = loanPhrase(head);
      if (loan && loan.bad) return null;
      const pct = loan ? { expr: loan.expr, asPercent: loan.asPercent } : percentages(head);
      const v = tryEval(pct.expr, scope);
      if (v === NO_ANSWER) return null; // shorter heads would answer "price / 0" with the price
      if (v !== undefined) return { value: v, asPercent: pct.asPercent, note: words.slice(end).join("").trim() };
    }
    return null;
  }

  // Is this a name math.js already knows: a constant (pi), function (sqrt) or unit (km, CAD)?
  // A one- or two-letter unit symbol standing alone in arithmetic ("a + b", where b would be
  // bytes and m metres) is far more likely a name the user forgot to define, so it counts as
  // unknown there. Attached to a number ("5 m") or after to/in, it stays a unit.
  function isKnownName(name, parent) {
    let v;
    try { v = math.evaluate(name); } catch (e) { return false; }
    if (v && v.isUnit && name.length <= 2 && parent && parent.type === "OperatorNode" &&
        !parent.implicit && parent.fn !== "to") return false;
    return true;
  }

  // If a line reads as maths that uses names nobody defined (e.g. "occ * prev" before
  // "occ = 95%"), return those names so the UI can say so instead of showing nothing.
  // A word sitting right after a number ("15% tip", "1850 rent") is a note, not a name:
  // math.js reads that as implicit multiplication, so any unknown word inside one means
  // the line has a note and the normal note handling applies. Only names joined by an
  // explicit operator ("a + b", "occ * prev") count as undefined.
  function unknownNames(expr, scope) {
    if (!/[+\-*\/^=]/.test(expr)) return null;
    let node;
    try { node = math.parse(expr); } catch (e) { return null; }
    let hasNote = false;
    const names = [];
    node.traverse((n, path, parent) => {
      if (n.type !== "SymbolNode") return;
      if (parent && parent.type === "FunctionNode" && parent.fn === n) return;   // sqrt in sqrt(16)
      if (parent && parent.type === "AssignmentNode" && parent.object === n) return; // the name being defined
      if (n.name in scope || isKnownName(n.name, parent)) return;
      if (parent && parent.type === "OperatorNode" && parent.implicit) hasNote = true;
      else names.push(n.name);
    });
    return hasNote || !names.length ? null : [...new Set(names)];
  }

  function isNumberLike(v) {
    return typeof v === "number" || (v && (v.isBigNumber || v.isFraction));
  }

  function format(v, asPercent) {
    if (isCurrency(v)) {
      const code = v.units[0].unit.name;
      return v.toNumber(code).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + code;
    }
    if (v && v.isUnit) {
      return math.format(v, { notation: "fixed", precision: 4 }).replace(/(\.\d*?)0+(\s)/, "$1$2").replace(/\.(\s)/, "$1");
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    if (!isNumberLike(v)) return math.format(v, { precision: 10 });
    const n = Number(v);
    if (asPercent === "fraction") return format(n * 100, true);
    const abs = Math.abs(n);
    const digits = abs !== 0 && abs < 0.01 ? 6 : 2;
    const s = n.toLocaleString("en-US", { maximumFractionDigits: digits });
    return asPercent ? s + "%" : s;
  }

  // Evaluate a whole sheet. Returns one entry per line:
  //   {kind: "result"|"heading"|"blank"|"note", text, value, display, note}
  function evaluateSheet(text) {
    const scope = {};
    const out = [];
    let prev;
    let block = []; // results since the last blank line or heading

    // total adds everything it can: plain numbers, or same-kind units such as mixed currencies
    // (converted into the first one). If the block mixes kinds, it falls back to the plain numbers.
    const blockTotal = () => {
      if (!block.length) return 0;
      try { return block.slice(1).reduce((a, b) => math.add(a, b), block[0]); }
      catch (e) { return block.filter(isNumberLike).reduce((a, b) => a + Number(b), 0); }
    };

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, "");
      const trimmed = line.trim();

      if (!trimmed) { out.push({ kind: "blank" }); block = []; continue; }
      if (/^#/.test(trimmed)) { out.push({ kind: "heading", text: trimmed.replace(/^#+\s*/, "") }); block = []; continue; }

      scope.prev = scope.pr = scope.ans = prev === undefined ? 0 : prev;
      scope.total = scope.sum = blockTotal();

      const body = normalise(stripLabel(trimmed));
      // Undefined names are decided on the whole line first, so "total = a + b" says "a, b"
      // rather than quietly answering the "total" at its start.
      const names = unknownNames(percentages(body).expr, scope);
      if (names) { out.push({ kind: "unknown", names }); continue; }
      const r = evalWithNote(body, scope);
      if (!r) { out.push({ kind: "note" }); continue; }

      prev = r.value;
      if (isNumberLike(r.value)) block.push(Number(r.value));
      else if (r.value && r.value.isUnit) block.push(r.value);
      out.push({ kind: "result", value: r.value, display: format(r.value, r.asPercent), note: r.note });
    }
    return out;
  }

  return { evaluateSheet, format, setRates, rates: () => ratesInfo };
});
