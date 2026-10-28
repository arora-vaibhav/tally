// Tally predictions: what to show, faint, after the caret. Everything comes from text already
// on this PC (the open sheet, and optionally the other sheets in the folder); nothing is sent
// anywhere. Two kinds, tried in order:
//   1. the rest of a line you have written before that starts the same way
//      ("need = price *" -> " 6.25%   NOI needed at a six and a quarter cap")
//   2. the rest of the word or number being typed: a name defined in the sheet, a Tally word
//      or unit, a word used before, or a number used before ("4,9" -> "75,000")
// Works in the browser (window.TallyPredict) and in Node (module.exports) for tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TallyPredict = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Tally's own words and the units and currencies people type most; completed from 2 letters.
  // Order breaks ties, so the real-estate units come before the maths functions (sqft before sqrt).
  const WORDS = ["total", "prev", "of", "off", "on", "as", "to", "in",
    "months", "month", "years", "year", "weeks", "days", "hours", "minutes",
    "sqft", "sqm", "acres", "hectares", "miles", "km", "meters", "feet", "inches", "kg", "lb", "liters", "gallons",
    "sqrt", "round",
    "USD", "CAD", "EUR", "GBP", "CHF", "JPY", "AUD", "INR", "MXN", "CNY"];

  // Words take any letter, so French notes ("Montréal", "école") are words, not fragments.
  // A number never ends on a comma: in "4,975,000, plus GST" the comma is punctuation.
  const WORD = /[\p{L}_][\p{L}\p{N}_]*/gu;
  const NUMBER = /\d+(?:,\d+)*(?:\.\d+)?[kKMB%]?/g;
  const NAME = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)/u;

  function bump(map, key, display) {
    const e = map.get(key);
    if (e) e.n++;
    else map.set(key, { w: display, n: 1 });
  }

  // index reads lines into what suggest() searches. Later lines count as more recent.
  function index(lines) {
    const ix = { lines: [], words: new Map(), numbers: new Map(), names: new Map() };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) continue;
      ix.lines.push(line);
      const name = line.match(NAME);
      if (name) bump(ix.names, name[1].toLowerCase(), name[1]);
      for (const w of line.match(WORD) || []) if (w.length >= 3) bump(ix.words, w.toLowerCase(), w);
      for (const n of line.match(NUMBER) || []) if (n.length >= 3) bump(ix.numbers, n, n);
    }
    return ix;
  }

  // restAfter: if cand starts with typed (ignoring case, and treating any run of spaces as one
  // space), the part of cand after it; otherwise null.
  function restAfter(typed, cand) {
    let i = 0, j = 0;
    while (j < typed.length) {
      if (i >= cand.length) return null;
      const ts = /\s/.test(typed[j]), cs = /\s/.test(cand[i]);
      if (ts || cs) {
        if (!(ts && cs)) return null;
        while (j < typed.length && /\s/.test(typed[j])) j++;
        while (i < cand.length && /\s/.test(cand[i])) i++;
        if (j === typed.length) return cand.slice(i); // the separator is already typed
        continue;
      }
      if (typed[j].toLowerCase() !== cand[i].toLowerCase()) return null;
      i++; j++;
    }
    return cand.slice(i);
  }

  // Whole-line suggestion from one index: the most common continuation, ties to the latest.
  function fromLines(typed, ix) {
    const seen = new Map();
    ix.lines.forEach((line, k) => {
      const rest = restAfter(typed, line);
      if (rest && rest.trim()) {
        const e = seen.get(rest) || { n: 0, last: 0 };
        e.n++; e.last = k;
        seen.set(rest, e);
      }
    });
    let best = "", bn = 0, bl = -1;
    for (const [rest, e] of seen) if (e.n > bn || (e.n === bn && e.last > bl)) { best = rest; bn = e.n; bl = e.last; }
    return best;
  }

  function bestOf(map, partial, minLen) {
    if (partial.length < minLen) return "";
    const p = partial.toLowerCase();
    let best = "", bn = 0;
    for (const [k, e] of map) if (k.length > p.length && k.startsWith(p) && e.n > bn) { best = e.w; bn = e.n; }
    return best;
  }

  // suggest returns the text to show after the caret, or "". before is the caret's line up to
  // the caret; here indexes the rest of the open sheet; others the other sheets (or null).
  function suggest(before, here, others) {
    if (!before.trim()) return "";
    const sources = others ? [here, others] : [here];

    if (before.replace(/\s/g, "").length >= 3) {
      for (const ix of sources) {
        const rest = fromLines(before, ix);
        if (rest) return rest;
      }
    }

    let m = before.match(/(?:^|[^\p{L}\p{N}_.,$])([\p{L}_][\p{L}\p{N}_]*)$/u);
    if (m) {
      const partial = m[1], p = partial.toLowerCase();
      // a Tally word or a name in this sheet is already complete ("of" is not turned into "off")
      const known = here.names.has(p) || WORDS.some(w => w.toLowerCase() === p);
      if (known) return "";
      const pick = bestOf(here.names, partial, 1) ||
        (partial.length >= 2 && WORDS.find(w => w.length > p.length && w.toLowerCase().startsWith(p))) ||
        bestOf(here.words, partial, 2) ||
        (others && (bestOf(others.names, partial, 2) || bestOf(others.words, partial, 3))) || "";
      return pick ? pick.slice(partial.length) : "";
    }

    m = before.match(/(?:^|[^\p{L}\p{N}_.,])(\d[\d,]*(?:\.\d*)?)$/u);
    if (m && m[1].replace(/\D/g, "").length >= 2) {
      const partial = m[1];
      for (const ix of sources) {
        let best = "", bn = 0;
        for (const [k, e] of ix.numbers) if (k.length > partial.length && k.startsWith(partial) && e.n > bn) { best = k; bn = e.n; }
        if (best) return best.slice(partial.length);
      }
    }
    return "";
  }

  return { index, suggest, restAfter, WORDS };
});
