package io.github.aroravaibhav.tally

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

// The sheets, as main.go, folder.go and open.go keep them on Windows: each tab is a plain .note
// or .txt file in one folder, _tabs.json keeps the order, the active tab and creation dates,
// and closing a tab moves its file to Trash; nothing is deleted. Every folder lives under
// root (the app's own Sheets folder), so a name or path from the page can never reach out of it.
// Calls come one at a time from a single thread, which stands in for mu.
class Sheets(rootDir: File, private val settingsFile: File) {
    private val root: File = rootDir.apply { mkdirs() }.canonicalFile
    var dir: File
        private set
    private var files = mutableMapOf<String, String>() // tab name -> file name in dir
    private var pendingOpen: File? = null

    init {
        val last = File(readSettings().optString("folder"))
        dir = if (inRoot(last) && last.isDirectory) last.canonicalFile else File(root, "Tally")
        dir.mkdirs()
    }

    fun load(): JSONObject {
        val found = linkedMapOf<String, String>()
        for (f in (dir.listFiles() ?: throw Exception("cannot read ${dir.path}")).sortedBy { it.name }) {
            if (!f.isFile || !isSheetFile(f.name)) continue
            var name = f.name.substringBeforeLast('.')
            if (name in found) name = f.name // "Deal.note" next to "Deal.txt": show the second with its extension
            found[name] = f.name
        }
        val st = readState()
        val order = st.optJSONArray("order") ?: JSONArray()
        val rank = (0 until order.length()).associateBy { order.optString(it) }
        val created = st.optJSONObject("created") ?: JSONObject().also { st.put("created", it) }
        var backfilled = false
        val out = mutableListOf<JSONObject>()
        for ((name, file) in found) {
            val f = File(dir, file)
            val text = utf8(f.readBytes()) ?: continue // a file in another encoding is left alone, not rewritten
            if (!created.has(name)) { // sheets from before dates were tracked: when the file was last written
                created.put(name, rfc3339(f.lastModified()))
                backfilled = true
            }
            out += JSONObject().put("name", name).put("text", text.replace("\r\n", "\n")).put("created", created.getString(name))
        }
        if (backfilled) writeState(st)
        // known order first, new files after, by name
        out.sortWith(compareBy({ rank[it.getString("name")] == null }, { rank[it.getString("name")] ?: 0 }, { it.getString("name") }))
        files = found
        var active = st.optString("active")
        pendingOpen?.let { p -> // a file Tally was asked to open: show its tab
            if (p.parentFile?.canonicalPath == dir.canonicalPath) files.forEach { (n, f) -> if (f.equals(p.name, true)) active = n }
            pendingOpen = null
        }
        return JSONObject().put("sheets", JSONArray(out)).put("active", active).put("folder", dir.path).put("recent", JSONArray(recent()))
    }

    fun save(name: String, text: String) = writeAtomic(pathOf(name), text.replace("\n", "\r\n").toByteArray())

    fun create(name: String): JSONObject {
        val n = unique(name)
        writeAtomic(File(dir, "$n.note"), ByteArray(0))
        files[n] = "$n.note"
        val now = rfc3339(System.currentTimeMillis())
        val st = readState()
        (st.optJSONObject("created") ?: JSONObject().also { st.put("created", it) }).put(n, now)
        writeState(st)
        return JSONObject().put("name", n).put("created", now)
    }

    fun rename(oldName: String, newName: String): String {
        if (cleanName(newName) == cleanName(oldName)) return oldName // the tab keeps the name its file is known by
        val n = unique(newName)
        val src = pathOf(oldName)
        val f = n + "." + src.name.substringAfterLast('.', "note") // a renamed sheet keeps its .txt or .note
        Files.move(src.toPath(), File(dir, f).toPath())
        files.remove(oldName)
        files[n] = f
        val st = readState() // the creation date follows the sheet to its new name
        st.optJSONObject("created")?.let { c -> if (c.has(oldName)) { c.put(n, c.get(oldName)); c.remove(oldName); writeState(st) } }
        return n
    }

    fun trash(name: String) {
        val src = pathOf(name)
        if (!src.exists()) return
        val bin = File(dir, "Trash").apply { mkdirs() }
        val stamp = OffsetDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HHmm"))
        Files.move(src.toPath(), File(bin, "${src.name.substringBeforeLast('.')} (closed $stamp).${src.name.substringAfterLast('.')}").toPath())
        files.remove(name)
    }

    fun order(names: JSONArray, active: String) {
        val st = readState() // keep the creation dates
        writeState(st.put("order", names).put("active", active))
    }

    /** useFolder in folder.go: switch to folder and remember it; on any failure nothing changes. */
    fun useFolder(path: String): JSONObject {
        val folder = File(path)
        if (!inRoot(folder) || !folder.isDirectory) throw Exception("folder not found: $path")
        val old = dir
        dir = folder.canonicalFile
        try {
            val res = load()
            val s = readSettings()
            writeSettings(s.put("folder", dir.path).put("recent", JSONArray(addRecent(s, dir.path))))
            return res.put("recent", JSONArray(recent()))
        } catch (e: Exception) {
            dir = old
            runCatching { load() } // files must describe the folder in use again
            throw e
        }
    }

    /** openPath in open.go: show the folder a file is in, on that file's tab. */
    fun openPath(path: String): JSONObject {
        val f = File(path)
        pendingOpen = f
        try { return useFolder(f.parent ?: "") } finally { pendingOpen = null }
    }

    /** The folders "choose folder" offers: each folder under root is one set of sheets. */
    fun folders(): List<File> = (root.listFiles() ?: emptyArray()).filter { it.isDirectory }.sortedBy { it.name.lowercase() }

    fun newFolder(name: String): File = File(root, cleanName(name)).apply { mkdirs() }

    /** A file opened from another app becomes a sheet here, under a name no other sheet has. */
    fun import(fileName: String, bytes: ByteArray): File {
        val ext = fileName.substringAfterLast('.').lowercase()
        val n = unique(fileName.substringBeforeLast('.'))
        return File(dir, "$n.$ext").also { writeAtomic(it, bytes) }
    }

    // ---- helpers --------------------------------------------------------------

    private fun pathOf(name: String) = File(dir, files[name] ?: (cleanName(name) + ".note"))

    private fun unique(name: String) = uniqueName(name) { n ->
        n in files || File(dir, "$n.txt").exists() || File(dir, "$n.note").exists()
    }

    private fun inRoot(f: File) = f.path != "" && f.canonicalPath.startsWith(root.path + File.separator)

    private fun readState(): JSONObject = readJson(File(dir, "_tabs.json"))
    private fun writeState(s: JSONObject) = writeAtomic(File(dir, "_tabs.json"), s.toString(2).toByteArray())

    private fun readSettings(): JSONObject = readJson(settingsFile)
    private fun writeSettings(s: JSONObject) = writeAtomic(settingsFile, s.toString(2).toByteArray())

    // addRecent in folder.go: folder first, the others after, at most 8
    private fun addRecent(s: JSONObject, folder: String): List<String> {
        val old = s.optJSONArray("recent") ?: JSONArray()
        return (listOf(folder) + (0 until old.length()).map { old.optString(it) }.filter { it != folder }).take(8)
    }

    // the switch list for the page: the folder in use first, then the others that still exist
    private fun recent(): List<String> =
        addRecent(readSettings(), dir.path).filter { it == dir.path || (inRoot(File(it)) && File(it).isDirectory) }

    private fun readJson(f: File): JSONObject = try { JSONObject(f.readText()) } catch (e: Exception) { JSONObject() }

    companion object {
        // writeAtomic in main.go: a temp file and a rename, so a crash never leaves half a sheet
        fun writeAtomic(f: File, b: ByteArray) {
            f.parentFile?.mkdirs()
            val tmp = File(f.path + ".tmp")
            tmp.writeBytes(b)
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }

        fun rfc3339(ms: Long): String = OffsetDateTime.ofInstant(Instant.ofEpochMilli(ms), ZoneId.systemDefault())
            .truncatedTo(ChronoUnit.SECONDS).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

        private fun utf8(b: ByteArray): String? = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString()
        } catch (e: Exception) { null }
    }
}
