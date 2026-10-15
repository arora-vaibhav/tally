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

  function stripLabel(s) {
    // "Gross rent: 28 * 1950" -> "28 * 1950"; leaves "a:b" ratios alone.
    const m = s.match(/^\s*([A-Za-z][A-Za-z0-9 _'()-]{0,40}):\s+(.+)$/);
    return m ? m[2] : s;
  }

  function tryEval(expr, scope) {
    try {
      const node = math.parse(expr);
      // A bare word that is not a known variable is a note, not a result.
      if (node.type === "SymbolNode" && !(node.name in scope)) return undefined;
      const v = node.evaluate(scope);
      if (typeof v === "function" || v === undefined || v === null) return undefined;
      if (typeof v === "number" && !isFinite(v)) return undefined;
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
      const pct = percentages(head);
      const v = tryEval(pct.expr, scope);
      if (v !== undefined) return { value: v, asPercent: pct.asPercent, note: words.slice(end).join("").trim() };
    }
    return null;
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

      const r = evalWithNote(normalise(stripLabel(trimmed)), scope);
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
