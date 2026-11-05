package io.github.aroravaibhav.tally

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.security.MessageDigest

// The network side of the host: listing pages (fetch.go), exchange rates (main.go) and
// updates (update.go), each the same requests and limits as on Windows.
object Net {
    private const val FETCH_LIMIT = 15 shl 20
    private const val FETCH_MS = 40_000L
    const val TOO_LARGE = "the page is too large"

    /**
     * fetchPage in fetch.go. Only http and https, GET or POST, at most 15 MB; nothing is sent
     * but the request the site reader asked for. Returns {status, url, type, body}.
     */
    fun fetch(link: String, opts: JSONObject?): JSONObject {
        var url = try { URL(link) } catch (e: Exception) { throw Exception("not a web link") }
        if ((url.protocol != "http" && url.protocol != "https") || url.host.isNullOrEmpty()) throw Exception("not a web link")
        url = https(url)
        var method = (opts?.optString("method") ?: "").uppercase().ifEmpty { "GET" }
        if (method != "GET" && method != "POST") throw Exception("only GET and POST")
        var body = opts?.optString("body") ?: ""
        val headers = opts?.optJSONObject("headers")
        val deadline = System.currentTimeMillis() + FETCH_MS
        // redirects by hand, so each hop is checked and upgraded to https like the first
        repeat(10) {
            val c = url.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = FETCH_MS.toInt()
            c.readTimeout = FETCH_MS.toInt()
            c.requestMethod = method
            // what a browser sends, so sites serve the normal page; French first for Quebec sites
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
            c.setRequestProperty("Accept-Language", "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7")
            headers?.keys()?.forEach { k -> c.setRequestProperty(k, headers.optString(k)) }
            try {
                if (body.isNotEmpty()) {
                    c.doOutput = true
                    c.outputStream.use { it.write(body.toByteArray()) }
                }
                val status = c.responseCode
                val next = c.getHeaderField("Location")
                if (status in listOf(301, 302, 303, 307, 308) && next != null) {
                    url = URL(url, next)
                    if (url.protocol != "http" && url.protocol != "https") throw Exception("not a web link")
                    url = https(url)
                    if (status in 301..303) { method = "GET"; body = "" } // as Go's client does; 307 and 308 resend
                    return@repeat
                }
                val type = c.contentType ?: ""
                val bytes = (if (status >= 400) c.errorStream else c.inputStream)?.let { read(it, FETCH_LIMIT, deadline) } ?: ByteArray(0)
                val cs = Regex("charset=\"?([\\w-]+)", RegexOption.IGNORE_CASE).find(type)?.groupValues?.get(1)
                val text = String(bytes, runCatching { Charset.forName(cs!!) }.getOrDefault(Charsets.UTF_8))
                return JSONObject().put("status", status).put("url", url.toString()).put("type", type).put("body", text)
            } finally {
                c.disconnect()
            }
        }
        throw Exception("too many redirects")
    }

    // Android blocks plain http (cleartext stays off app-wide), so an http link or redirect hop
    // is tried over https instead; listing sites serve both. A site that has no https fails here
    // while Windows would read it.
    private fun https(u: URL) = if (u.protocol == "http") URL("https", u.host, if (u.port == 80) -1 else u.port, u.file) else u

    // also bounds files opened from other apps (MainActivity.importFile)
    fun read(input: InputStream, limit: Int, deadline: Long): ByteArray = input.use {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = it.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > limit) throw Exception(TOO_LARGE)
            if (System.currentTimeMillis() > deadline) throw Exception("the site took too long to answer")
        }
        out.toByteArray()
    }

    // ---- exchange rates ------------------------------------------------------

    /** cachedRates in main.go: whatever is cached, or null; the page never waits on the network. */
    fun cachedRates(file: File): JSONObject? = try { JSONObject(file.readText()) } catch (e: Exception) { null }

    /** refreshRates in main.go: ECB rates via Frankfurter when the cache is missing or 12 hours old. Reports whether it changed. */
    fun refreshRates(file: File): Boolean {
        if (cachedRates(file) != null && System.currentTimeMillis() - file.lastModified() < 12 * 3600_000L) return false
        return try {
            val c = URL("https://api.frankfurter.dev/v1/latest?base=USD").openConnection() as HttpURLConnection
            c.connectTimeout = 10_000; c.readTimeout = 10_000
            val r = try {
                if (c.responseCode != 200) return false
                JSONObject(String(read(c.inputStream, 1 shl 20, System.currentTimeMillis() + 10_000)))
            } finally { c.disconnect() }
            if (r.optString("base").isEmpty() || (r.optJSONObject("rates")?.length() ?: 0) == 0) return false
            r.put("fetched", Sheets.rfc3339(System.currentTimeMillis())).put("source", "European Central Bank via frankfurter.dev")
            Sheets.writeAtomic(file, r.toString(2).toByteArray())
            true
        } catch (e: Exception) { false }
    }
}

/**
 * update.go for the phone: a release build checks the latest GitHub release, downloads
 * Tally-android.apk when it is newer, and keeps it only if its SHA-256 matches the one the
 * release publishes. Installing it is left to the system installer, which also refuses an
 * APK not signed with the same key as the installed app.
 */
object Updater {
    private const val LATEST = "https://api.github.com/repos/arora-vaibhav/tally/releases/latest"
    const val ASSET = "Tally-android.apk"

    @Volatile var staged = "" // the version downloaded, verified and waiting to install

    fun apk(cacheDir: File) = File(cacheDir, "updates/$ASSET")

    /** checkUpdate in update.go: the tag of a verified newer build, or "". */
    fun check(version: String, cacheDir: File): String {
        if (staged != "") return staged
        if (parseVersion(version) == null) return "" // a development build
        val c = URL(LATEST).openConnection() as HttpURLConnection
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "Tally/$version")
        c.connectTimeout = 30_000; c.readTimeout = 30_000
        val rel = try {
            if (c.responseCode != 200) throw Exception("release check: ${c.responseCode}")
            JSONObject(c.inputStream.use { String(it.readBytes()) })
        } finally { c.disconnect() }
        val tag = rel.optString("tag_name")
        if (!newer(tag, version)) return ""
        var url = ""
        var want = ""
        val assets = rel.optJSONArray("assets")
        for (i in 0 until (assets?.length() ?: 0)) {
            val a = assets!!.getJSONObject(i)
            if (a.optString("name") != ASSET) continue
            url = a.optString("browser_download_url")
            a.optString("digest").takeIf { it.startsWith("sha256:") }?.let { want = it.removePrefix("sha256:").lowercase() }
        }
        if (want == "") want = shaFromNotes(rel.optString("body"), ASSET)
        if (url == "" || want == "") throw Exception("release has no Android build or checksum")
        download(url, apk(cacheDir), want, version)
        staged = tag
        return tag
    }

    private fun download(url: String, dst: File, wantSHA: String, version: String) {
        dst.parentFile?.mkdirs()
        val tmp = File(dst.path + ".tmp")
        val h = MessageDigest.getInstance("SHA-256")
        val c = URL(url).openConnection() as HttpURLConnection // GitHub redirects to its CDN, https to https
        c.setRequestProperty("User-Agent", "Tally/$version")
        c.connectTimeout = 30_000; c.readTimeout = 60_000
        try {
            if (c.responseCode != 200) throw Exception("download: ${c.responseCode}")
            c.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > 200L shl 20) throw Exception("download is too large")
                        h.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
        } finally { c.disconnect() }
        val got = h.digest().joinToString("") { "%02x".format(it) }
        if (got != wantSHA) {
            tmp.delete()
            throw Exception("download checksum $got does not match the release ($wantSHA)")
        }
        if (!tmp.renameTo(dst)) throw Exception("cannot keep the download")
    }
}
