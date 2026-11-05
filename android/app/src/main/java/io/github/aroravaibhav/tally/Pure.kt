package io.github.aroravaibhav.tally

// The parts of the host that need nothing from Android, so they run in plain JVM tests.
// Each one matches its Go twin, so a sheets folder means the same on both.

private const val BAD = "<>:\"/\\|?*"

/** cleanName in main.go: a tab name made safe as a file name, never a path. */
fun cleanName(name: String): String {
    var n = buildString {
        name.trim().codePoints().forEach { c ->
            if (c < 32 || (c < 128 && BAD.indexOf(c.toChar()) >= 0)) append('-') else appendCodePoint(c)
        }
    }.trim('.', ' ')
    val cps = n.codePoints().toArray()
    if (cps.size > 80) n = String(cps, 0, 80)
    return n.ifEmpty { "Sheet" }
}

/** uniqueName in main.go: name, or "name (2)", "name (3)"... whichever is not taken. */
fun uniqueName(name: String, taken: (String) -> Boolean): String {
    val base = cleanName(name)
    var n = base
    var i = 2
    while (taken(n)) n = "$base (${i++})"
    return n
}

/** Sheets are .note files (Tally's own) or plain .txt files. */
fun isSheetFile(name: String): Boolean =
    name.substringAfterLast('.', "").lowercase().let { it == "txt" || it == "note" }

/** parseVersion in update.go: "v1.2.3" or "1.2"; null for anything else, such as "dev". */
fun parseVersion(v: String): IntArray? {
    val parts = v.trim().removePrefix("v").split(".")
    if (parts.size < 2 || parts.size > 3) return null
    val n = IntArray(3)
    for ((i, p) in parts.withIndex()) n[i] = p.toIntOrNull()?.takeIf { it >= 0 } ?: return null
    return n
}

/** newer in update.go: whether release tag a is a later version than b. */
fun newer(a: String, b: String): Boolean {
    val x = parseVersion(a) ?: return false
    val y = parseVersion(b) ?: return false
    for (i in 0..2) if (x[i] != y[i]) return x[i] > y[i]
    return false
}

/** The "<sha256>  <file>" line in a release's notes, as expectedSHA in update.go reads it; "" if none. */
fun shaFromNotes(body: String, name: String): String {
    val m = Regex("(?mi)^\\s*([0-9a-f]{64})\\s+\\*?" + Regex.escape(name) + "\\s*$").find(body)
    return m?.groupValues?.get(1)?.lowercase() ?: ""
}
