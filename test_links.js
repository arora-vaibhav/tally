// node test_links.js : reading listing links (web/links.js and the site readers in web/sites/).
// Each site's cases are in testdata/links/<site>.cases.json: [{ url, want: { price, doors, ... } }],
// or { url, wantError: "part of the message" } for a site that refuses apps.
// The pages are recorded, so the test runs offline: node test_links.js --record fetches and
// saves them again (do it when a site changes), --live reads the real sites without saving.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const Links = require("./web/links.js");
for (const f of fs.readdirSync("web/sites")) require("./web/sites/" + f);
const mode = process.argv.includes("--record") ? "record" : process.argv.includes("--live") ? "live" : "replay";
const only = process.argv.slice(2).find(a => !a.startsWith("--"));
const DIR = path.join("testdata", "links");
let fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

// what Tally's fetch sends (fetch.go, and the Android app)
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7",
};
const key = (url, o) => crypto.createHash("sha1").update(JSON.stringify([url, o && o.method || "GET", o && o.body || ""])).digest("hex").slice(0, 16);
async function live(url, o) {
  o = o || {};
  const headers = Object.assign({}, HEADERS, o.headers || {});
  const r = await fetch(url, { method: o.method || "GET", headers, body: o.body || undefined });
  const got = { status: r.status, url: r.url, type: r.headers.get("content-type") || "", body: await r.text() };
  // Cloudflare refuses Node's fetch by its TLS fingerprint on some sites (PMML, CBRE, Spacelist)
  // while the app's Go fetch and curl get the page with the same headers: ask curl instead
  return got.status === 403 || got.status === 503 ? curl(url, o, headers) || got : got;
}
function curl(url, o, headers) {
  const args = ["-s", "-L", "--compressed", "--max-time", "40", "-X", o.method || "GET", "-w", "\n%{http_code} %{url_effective} %{content_type}"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (o.body) args.push("--data-raw", o.body);
  try {
    const out = require("child_process").execFileSync("curl", [...args, url], { maxBuffer: 32 << 20 }).toString();
    const i = out.lastIndexOf("\n"), [status, final, type] = out.slice(i + 1).split(" ");
    return { status: Number(status), url: final, type: type || "", body: out.slice(0, i) };
  } catch (e) { return null; }
}
const getFor = site => async (url, o) => {
  const file = path.join(DIR, site, key(url, o) + ".json.gz"); // gzipped, pages are large
  if (mode === "replay") {
    if (!fs.existsSync(file)) throw new Error("no recording of " + url + " (run node test_links.js --record)");
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  }
  const r = await live(url, o);
  // a refusal or a bot check (AWS WAF answers 202) is never saved over a good recording
  if (mode === "record" && (r.status < 200 || r.status > 299 || r.status === 202)) throw new Error(`${url} answered ${r.status}; recording kept`);
  if (mode === "record") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(r))); }
  return r;
};

(async () => {
  // what counts as a link
  check("bare link", Links.findLink(" https://www.centris.ca/fr/x/123 "), "https://www.centris.ca/fr/x/123");
  check("phone share text", Links.findLink("Regarde cette propriété sur Centris\nhttps://www.centris.ca/fr/x/123."), "https://www.centris.ca/fr/x/123");
  check("two links are not one listing", Links.findLink("https://a.ca/1 https://b.ca/2"), "");
  check("a pasted page is not a link", Links.findLink("Prix\n1 475 000 $\n".repeat(5) + "https://www.centris.ca/fr/x/123"), "");
  check("plain words", Links.findLink("price = 1,475,000"), "");
  const { htmlText, money } = Links.tools;
  check("page text, one block a line", htmlText("<div>Prix</div><div>1&nbsp;475&#160;000 $</div><script>x=1</script><p>Ann&eacute;e<br>1961</p>"), "Prix\n1 475 000 $\nAnnée\n1961");
  check("money", [money("$4,975,000"), money("4 975 000 $"), money(1250), money("n/a")], [4975000, 4975000, 1250, null]);

  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith(".cases.json")).sort()) {
    const site = f.replace(".cases.json", "");
    if (only && only !== site) continue;
    for (const c of JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))) {
      if (c.wantError) { // a reader that must refuse (a blocked site): its message, with no recording
        const msg = await Links.read(c.url, getFor(site)).then(() => "no error", e => e.message);
        check(`${site} ${c.url.slice(0, 90)} refuses`, msg.includes(c.wantError), true);
        continue;
      }
      try {
        const { L } = await Links.read(c.url, getFor(site));
        const got = {};
        for (const k of Object.keys(c.want)) got[k] = L[k];
        check(`${site} ${c.url.slice(0, 90)}`, got, c.want);
      } catch (e) { fail++; console.log(`FAIL ${site} ${c.url}: ${e.message}`); }
    }
  }
  console.log(fail ? `${fail} FAILED` : "ALL PASS");
  process.exitCode = fail ? 1 : 0; // not process.exit, which trips libuv on Windows with sockets open
})();
