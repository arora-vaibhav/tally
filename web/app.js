// Tally UI: tabs of sheets on one editing surface, with a syntax-coloured layer under a
// transparent textarea and each result on the right of its own line. Copy and print.
// Persistence goes through Go bindings (tally*) that write plain .txt files.
// Outside the app (no bindings) it falls back to localStorage so the page can be tried in a browser.
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const src = $("#src"), hl = $("#hl"), out = $("#out"), scroller = $("#scroll"), stack = $("#stack");
  const tabsEl = $("#tabs"), statusEl = $("#status"), countEl = $("#count");
  const LH = 28; // must match --lh

  // ---- storage ---------------------------------------------------------
  const native = typeof window.tallyLoad === "function";
  const store = native ? {
    load: () => window.tallyLoad(),
    save: (n, t) => window.tallySave(n, t),
    create: n => window.tallyCreate(n),
    rename: (o, n) => window.tallyRename(o, n),
    trash: n => window.tallyTrash(n),
    order: (names, active) => window.tallyOrder(names, active),
    folder: () => window.tallyOpenFolder(),
    choose: () => window.tallyChooseFolder(), // null when the picker is cancelled
    use: f => window.tallyUseFolder(f),
  } : (() => {
    const K = "tally.sheets";
    const read = () => { try { return JSON.parse(localStorage.getItem(K)) || { sheets: [], active: "" }; } catch (e) { return { sheets: [], active: "" }; } };
    const write = d => localStorage.setItem(K, JSON.stringify(d));
    const uniq = (d, n) => { let name = n, i = 2; while (d.sheets.some(s => s.name === name)) name = `${n} (${i++})`; return name; };
    return {
      load: async () => ({ ...read(), folder: "" }),
      save: async (n, t) => { const d = read(); const s = d.sheets.find(s => s.name === n); if (s) s.text = t; write(d); },
      create: async n => {
        const d = read(); const name = uniq(d, n), created = new Date().toISOString();
        d.sheets.push({ name, text: "", created }); write(d); return { name, created };
      },
      rename: async (o, n) => { const d = read(); const name = uniq(d, n); const s = d.sheets.find(s => s.name === o); if (s) s.name = name; write(d); return name; },
      trash: async n => { const d = read(); d.sheets = d.sheets.filter(s => s.name !== n); write(d); },
      order: async (names, active) => { const d = read(); d.sheets.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name)); d.active = active; write(d); },
      folder: async () => toast("Sheets are in browser storage here"),
      choose: async () => { toast("Folders need the Tally app"); return null; },
      use: async () => null,
    };
  })();

  // ---- state -----------------------------------------------------------
  let sheets = [];      // [{name, text, created}]

  // New sheets are named by the day they were made: 2026-10-14, then 2026-10-14 (2), (3)...
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const createdLabel = c => {
    if (!c) return "";
    const d = new Date(c);
    return isNaN(d) ? "" : "Created " + d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) +
      ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  let active = 0;
  let results = [];
  let folder = "";
  let recent = [];      // sheets folders to switch between, the current one first
  let saveTimer = null, dirty = false;
  const cur = () => sheets[active];

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 1400);
  }

  // ---- saving ----------------------------------------------------------
  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty || !cur()) return;
    dirty = false;
    try { await store.save(cur().name, cur().text); setStatus(); }
    catch (e) { dirty = true; statusEl.textContent = "Not saved: " + e; }
  }
  let ratesLabel = "";
  function setStatus() {
    const saved = folder ? "Saved to " + folder.replace(/^.*\\(?=[^\\]+\\[^\\]+$)/, "...\\") : "Saved";
    statusEl.textContent = saved + (ratesLabel ? "  ·  " + ratesLabel : "");
    statusEl.title = folder;
  }

  // ---- exchange rates ----------------------------------------------------
  async function loadRates() {
    let r = null;
    try {
      if (native) r = await window.tallyRates();
      else r = await (await fetch("https://api.frankfurter.dev/v1/latest?base=USD")).json();
    } catch (e) { r = null; }
    if (!r || !r.rates) { ratesLabel = "Currency rates unavailable offline"; setStatus(); return; }
    window.TallyEngine.setRates(r);
    const d = new Date(r.date + "T12:00:00");
    ratesLabel = "Rates " + d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " (ECB)";
    setStatus();
    if (sheets.length) recompute();
  }
  window.tallyRatesUpdated = loadRates;
  const saveOrder = () => store.order(sheets.map(s => s.name), cur() ? cur().name : "").catch(() => {});

  // ---- highlighting ----------------------------------------------------
  const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const KW = new Set(["of", "on", "off", "as", "to", "in", "x", "prev", "pr", "ans", "total", "sum"]);
  const TOKEN = /(\d[\d,]*(?:\.\d+)?(?:[kKMB](?![A-Za-z]))?%?)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*\/^×÷=%()])|(\$)|(\s+)|(.)/g;

  function colourExpr(s, unknown) {
    let html = "", m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(s))) {
      const t = esc(m[0]);
      if (m[1]) html += t;                                   // number
      else if (m[2] && unknown && unknown.has(m[2])) html += `<span class="u">${t}</span>`;
      else if (m[2]) html += KW.has(m[2].toLowerCase()) ? `<span class="k">${t}</span>` : `<span class="v">${t}</span>`;
      else if (m[3] || m[4]) html += `<span class="o">${t}</span>`;
      else html += t;
    }
    return html;
  }

  function colourLine(raw, r) {
    if (!raw) return "";
    if (r && r.kind === "heading") return `<span class="h">${esc(raw)}</span>`;
    let code = raw, comment = "";
    const ci = raw.indexOf("//");
    if (ci >= 0) { code = raw.slice(0, ci); comment = raw.slice(ci); }
    let html;
    if (r && r.kind === "unknown") html = colourExpr(code, new Set(r.names));
    else if (!r || r.kind !== "result") html = `<span class="n">${esc(code)}</span>`;
    else {
      let label = "", body = code, note = "";
      const lm = body.match(/^(\s*[A-Za-z][A-Za-z0-9 _'()-]{0,40}:\s+)/);
      if (lm) { label = lm[1]; body = body.slice(label.length); }
      const trimmed = body.replace(/\s+$/, ""), trail = body.slice(trimmed.length);
      if (r.note && trimmed.endsWith(r.note)) { note = r.note + trail; body = trimmed.slice(0, trimmed.length - r.note.length); }
      html = (label ? `<span class="n">${esc(label)}</span>` : "") + colourExpr(body) + (note ? `<span class="n">${esc(note)}</span>` : "");
    }
    return html + (comment ? `<span class="c">${esc(comment)}</span>` : "");
  }

  // ---- rendering -------------------------------------------------------
  let charW = 9;
  function measure() {
    const c = document.createElement("canvas").getContext("2d");
    c.font = getComputedStyle(src).font;
    charW = c.measureText("0000000000").width / 10 || 9;
  }

  function recompute() {
    const text = src.value;
    results = window.TallyEngine.evaluateSheet(text);
    const lines = text.split("\n");

    hl.innerHTML = lines.map((l, i) => colourLine(l, results[i])).join("\n") + "\n" +
      (text.trim() ? "" : `<span class="hint">Type a calculation, e.g.  28 x 1,950 x 12  gross rent</span>`);

    let widest = 0;
    out.innerHTML = results.map((r, i) => {
      if (r.kind === "unknown") {
        const list = r.names.join(", ");
        const tip = `${list} ${r.names.length === 1 ? "is" : "are"} not defined yet. Name a value first, e.g.  ${r.names[0]} = 95%`;
        return `<div><span class="unk" title="${esc(tip)}">? ${esc(list)}</span></div>`;
      }
      if (r.kind !== "result") return "<div></div>";
      widest = Math.max(widest, r.display.length);
      return `<div><span class="r" data-i="${i}" title="Click to copy">${esc(r.display)}</span></div>`;
    }).join("");
    const resw = Math.min(Math.max(widest * charW + 96, 160), Math.max(scroller.clientWidth * 0.45, 160));
    document.documentElement.style.setProperty("--resw", resw + "px"); // results column and the divider share it

    const n = results.filter(r => r.kind === "result").length;
    countEl.textContent = n ? `${n} result${n === 1 ? "" : "s"}` : "";
  }

  function keepCaretVisible() {
    const before = src.value.slice(0, src.selectionEnd);
    const line = before.split("\n").length - 1;
    const col = before.length - before.lastIndexOf("\n") - 1;
    const y = 10 + line * LH, x = 26 + col * charW;
    if (y < scroller.scrollTop) scroller.scrollTop = y - 8;
    else if (y + LH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + LH - scroller.clientHeight + 8;
    const visibleW = scroller.clientWidth - parseFloat(getComputedStyle(stack).getPropertyValue("--resw") || 200);
    if (x < scroller.scrollLeft + 26) scroller.scrollLeft = Math.max(0, x - 60);
    else if (x > scroller.scrollLeft + visibleW) scroller.scrollLeft = x - visibleW + 60;
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    sheets.forEach((s, i) => {
      const t = document.createElement("div");
      t.className = "tab" + (i === active ? " active" : "");
      t.title = [s.name, createdLabel(s.created), "Double-click to rename, middle-click to close"].filter(Boolean).join("\n");
      const label = document.createElement("span"); label.className = "t"; label.textContent = s.name;
      const x = document.createElement("span"); x.className = "x"; x.title = "Close";
      x.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      t.append(label, x);
      t.addEventListener("mousedown", e => { if (e.button === 1) { e.preventDefault(); closeSheet(i); } });
      t.addEventListener("click", e => { if (x.contains(e.target)) closeSheet(i); else if (i !== active) switchTo(i); });
      t.addEventListener("dblclick", e => { if (!x.contains(e.target)) beginRename(i, label); });
      tabsEl.append(t);
    });
    const a = tabsEl.children[active]; if (a) a.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function switchTo(i) {
    if (i < 0 || i >= sheets.length) return;
    flush();
    active = i;
    src.value = cur().text;
    scroller.scrollTop = 0; scroller.scrollLeft = 0;
    renderTabs(); recompute(); saveOrder();
    document.title = cur().name + " - Tally";
    // always open at the top with the caret at the end; the view follows the caret once you type or move.
    // (Scrolling to the caret here misfired at startup, before the window had its final size.)
    src.focus({ preventScroll: true });
    src.setSelectionRange(src.value.length, src.value.length);
    scroller.scrollTop = 0; scroller.scrollLeft = 0;
    window.scrollTo(0, 0);
  }

  // ---- sheet actions ---------------------------------------------------
  async function newSheet() {
    await flush();
    const c = await store.create(today());
    sheets.push({ name: c.name, text: "", created: c.created }); // oldest to newest, left to right
    switchTo(sheets.length - 1);
  }

  async function closeSheet(i) {
    const s = sheets[i];
    if (s.text.trim() && !confirm(`Close "${s.name}"?\n\nIt moves to the Trash folder inside your sheets folder. Nothing is deleted.`)) return;
    await flush();
    await store.trash(s.name);
    sheets.splice(i, 1);
    if (!sheets.length) { const c = await store.create(today()); sheets.push({ name: c.name, text: "", created: c.created }); }
    if (i < active || active >= sheets.length) active = Math.max(0, active - 1);
    switchTo(Math.min(active, sheets.length - 1));
  }

  function beginRename(i, label) {
    const input = document.createElement("input");
    input.value = sheets[i].name;
    label.replaceWith(input); input.select(); input.focus();
    let done = false;
    const finish = async ok => {
      if (done) return; done = true;
      const want = input.value.trim();
      if (ok && want && want !== sheets[i].name) {
        await flush();
        try { sheets[i].name = await store.rename(sheets[i].name, want); } catch (e) { toast("Could not rename: " + e); }
        if (i === active) document.title = cur().name + " - Tally";
      }
      renderTabs(); saveOrder(); src.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); e.stopPropagation(); });
    input.addEventListener("blur", () => finish(true));
  }

  // ---- copy / print ----------------------------------------------------
  const lineRows = () => src.value.split("\n").map((text, i) => ({ text, r: results[i] || { kind: "blank" } }));
  const rawValue = r => typeof r.value === "number" ? String(Math.round(r.value * 1e6) / 1e6) : r.display.replace(/,/g, "");

  async function copyText(t, msg) {
    try { await navigator.clipboard.writeText(t); toast(msg); }
    catch (e) { toast("Clipboard blocked: " + e); }
  }

  function copyTable() {
    const rows = lineRows().filter(x => x.text.trim()).map(x =>
      x.r.kind === "heading" ? x.r.text : `${x.text.trim()}\t${x.r.kind === "result" ? x.r.display : ""}`);
    copyText(rows.join("\n"), "Copied as a table");
  }

  function printSheet() {
    flush();
    const now = new Date();
    const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const rows = lineRows();
    // no blank rows at the top or bottom of the page
    while (rows.length && !rows[0].text.trim()) rows.shift();
    while (rows.length && !rows[rows.length - 1].text.trim()) rows.pop();

    let html = `<div class="brand">Tally</div><h1>${esc(cur().name)}</h1><div class="meta">${esc(day)}</div><div class="rule"></div><table>`;
    let lastGap = false;
    for (const x of rows) {
      const t = x.text.trim();
      if (x.r.kind === "heading") { html += `<tr class="head"><td colspan="2">${esc(x.r.text)}</td></tr>`; lastGap = false; }
      else if (!t) { if (!lastGap) html += `<tr class="gap"><td colspan="2"></td></tr>`; lastGap = true; }
      else {
        const named = x.r.kind === "result" && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t);
        html += `<tr${named ? ' class="named"' : ""}><td class="expr">${colourLine(t, x.r)}</td>` +
          `<td class="res">${x.r.kind === "result" ? esc(x.r.display) : ""}</td></tr>`;
        lastGap = false;
      }
    }
    html += `</table><div class="end"><span>${esc(cur().name)}</span><span>Printed ${esc(day)}, ${esc(time)}</span></div>`;
    $("#printArea").innerHTML = html;
    window.print();
  }

  // ---- sheets folder ---------------------------------------------------
  const menu = $("#folderMenu");
  const trimSlash = f => f.replace(/[\\/]+$/, "");
  const baseName = f => trimSlash(f).split(/[\\/]/).pop() || f;
  const parentOf = f => trimSlash(f).replace(/[\\/][^\\/]*$/, "");
  const sameFolder = (a, b) => trimSlash(a).toLowerCase() === trimSlash(b).toLowerCase();

  let switching = false;
  async function openFolder(pick) {
    menu.classList.remove("on");
    if (switching) return;
    switching = true; src.readOnly = true; // no typing while the folder changes under the editor
    try {
      await flush(); // the open sheet is saved into the folder it came from
      if (dirty) { toast("This sheet could not be saved, so the folder was not switched"); return; }
      const data = await pick();
      if (!data) return; // picker cancelled
      await show(data, "");
      toast("Sheets from " + baseName(folder));
    } catch (e) { toast("Could not open folder: " + e); }
    finally { switching = false; src.readOnly = false; src.focus({ preventScroll: true }); }
  }
  const chooseFolder = () => openFolder(store.choose);

  function renderFolderMenu() {
    menu.innerHTML = "";
    const item = (tick, name, path, title, onClick) => {
      const d = document.createElement("div"); d.className = "item"; d.title = title;
      d.innerHTML = `<span class="tick">${tick}</span><span>${esc(name)}</span>` + (path ? `<span class="path">${esc(path)}</span>` : "");
      d.addEventListener("click", onClick);
      menu.append(d);
    };
    if (recent.length) {
      const l = document.createElement("div"); l.className = "label"; l.textContent = "Sheets folder"; menu.append(l);
      for (const f of recent) {
        const isCur = sameFolder(f, folder);
        item(isCur ? "&#10003;" : "", baseName(f), parentOf(f), f,
          () => isCur ? menu.classList.remove("on") : openFolder(() => store.use(f)));
      }
      menu.append(document.createElement("hr"));
    }
    item("", "Choose folder...", "Ctrl+O", "Pick or create a folder of sheets", chooseFolder);
    item("", "Show in Explorer", "", folder, () => { menu.classList.remove("on"); store.folder(); });
  }

  // ---- editor behaviour ------------------------------------------------
  function previousAnswerRaw() {
    const line = src.value.slice(0, src.selectionStart).split("\n").length - 1;
    for (let i = line - 1; i >= 0; i--) if (results[i] && results[i].kind === "result") return rawValue(results[i]);
    return "";
  }

  function onInput() {
    cur().text = src.value;
    recompute(); scheduleSave(); keepCaretVisible();
  }

  src.addEventListener("input", onInput);
  src.addEventListener("keyup", e => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key.startsWith("Page")) keepCaretVisible(); });
  src.addEventListener("click", keepCaretVisible);
  src.addEventListener("scroll", () => { src.scrollTop = 0; src.scrollLeft = 0; }); // the outer pane scrolls, never the textarea
  src.addEventListener("keydown", e => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      src.setRangeText(previousAnswerRaw() || "    ", src.selectionStart, src.selectionEnd, "end");
      onInput();
    }
  });

  out.addEventListener("click", e => {
    const el = e.target.closest(".r"); if (!el) return;
    const r = results[+el.dataset.i];
    el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 300);
    copyText(rawValue(r), "Copied " + r.display);
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { $("#help").classList.remove("on"); menu.classList.remove("on"); }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "t" || k === "n") { e.preventDefault(); newSheet(); }
    else if (k === "w") { e.preventDefault(); closeSheet(active); }
    else if (k === "p") { e.preventDefault(); printSheet(); }
    else if (k === "s") { e.preventDefault(); flush(); toast("Saved"); }
    else if (k === "o") { e.preventDefault(); chooseFolder(); }
    else if (e.key === "Tab") { e.preventDefault(); switchTo((active + (e.shiftKey ? -1 : 1) + sheets.length) % sheets.length); }
    else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); switchTo(Math.min(+e.key, sheets.length) - 1); }
  });

  $("#add").addEventListener("click", newSheet);
  $("#copyTable").addEventListener("click", copyTable);
  $("#printBtn").addEventListener("click", printSheet);
  $("#folder").addEventListener("click", e => {
    e.stopPropagation(); $("#help").classList.remove("on");
    if (!menu.classList.contains("on")) renderFolderMenu();
    menu.classList.toggle("on");
  });
  $("#helpBtn").addEventListener("click", e => { e.stopPropagation(); menu.classList.remove("on"); $("#help").classList.toggle("on"); });
  document.addEventListener("click", e => {
    if (!e.target.closest("#help")) $("#help").classList.remove("on");
    if (!e.target.closest("#folderMenu")) menu.classList.remove("on");
  });
  scroller.addEventListener("mousedown", e => { if (e.target === scroller || e.target === stack) { e.preventDefault(); src.focus(); } });
  window.addEventListener("resize", recompute);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  // ---- start -----------------------------------------------------------
  const SAMPLE = [
    "# Example",
    "28 x 1,956 x 12   gross rent",
    "prev x 0.95   less vacancy",
    "noi = prev x 0.62   NOI",
    "noi / 5.5%   value at 5.5 cap",
    "",
    "20% of 4,500",
    "4,500 + 15%",
    "5 km to miles",
  ].join("\n");

  // Show the sheets of one folder. An empty folder gets one sheet: the example the very
  // first time Tally runs, a blank one when switching to a new folder.
  async function show(data, firstText) {
    const list = (data.sheets || []).map(s => ({ name: s.name, text: s.text || "", created: s.created || "" }));
    if (!list.length) {
      const c = await store.create(today());
      list.push({ name: c.name, text: firstText, created: c.created });
      if (firstText) await store.save(c.name, firstText);
    }
    // only now replace the page's state, so a failure above leaves the old folder working
    folder = data.folder || ""; recent = data.recent || []; sheets = list;
    clearTimeout(saveTimer); dirty = false;
    const i = sheets.findIndex(s => s.name === data.active);
    active = 0;
    setStatus();
    switchTo(i >= 0 ? i : 0);
  }

  (async function start() {
    measure();
    await loadRates();
    await show(await store.load(), SAMPLE);
  })().catch(e => { statusEl.textContent = "Could not load sheets: " + e; });
})();
