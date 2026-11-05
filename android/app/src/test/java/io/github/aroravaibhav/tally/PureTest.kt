package io.github.aroravaibhav.tally

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The Go cases (main_test.go) plus a few more, so a sheet name means the same file on both.
class PureTest {
    @Test fun cleanNameMatchesGo() {
        assertEquals("a-b-c", cleanName("  a/b:c  "))
        assertEquals("Sheet", cleanName("..."))
        assertEquals("Deal- 1 2", cleanName("Deal: 1 2"))
        assertEquals("x", cleanName("..x.."))
        assertEquals("a-b", cleanName("a\u0007b"))
        assertEquals("-..-etc-passwd", cleanName("/../etc/passwd"))
        assertEquals("Café", cleanName("Café"))
        assertEquals(80, cleanName("é".repeat(100)).length)
    }

    @Test fun traversalNeverSurvives() {
        for (n in listOf("../x", "..\\x", "/x", "a/../../b", "..", "Trash/../..")) {
            val c = cleanName(n)
            assertFalse(n, c.contains('/') || c.contains('\\') || c.startsWith("."))
        }
    }

    @Test fun uniqueNameCounts() {
        val taken = setOf("2026-10-30", "2026-10-30 (2)")
        assertEquals("2026-10-30 (3)", uniqueName("2026-10-30") { it in taken })
        assertEquals("Deal", uniqueName("Deal") { false })
    }

    @Test fun sheetFiles() {
        assertTrue(isSheetFile("a.note"))
        assertTrue(isSheetFile("A.TXT"))
        assertFalse(isSheetFile("a.json"))
        assertFalse(isSheetFile("note"))
    }

    @Test fun versions() {
        assertArrayEquals(intArrayOf(1, 7, 0), parseVersion("v1.7.0"))
        assertArrayEquals(intArrayOf(1, 2, 0), parseVersion("1.2"))
        assertNull(parseVersion("dev"))
        assertNull(parseVersion("v1.2.3.4"))
        assertTrue(newer("v1.10.0", "v1.9.9"))
        assertFalse(newer("v1.7.0", "v1.7.0"))
        assertFalse(newer("v2.0.0", "dev"))
    }

    @Test fun checksumFromReleaseNotes() {
        val apk = "a".repeat(64)
        val exe = "B".repeat(64)
        val notes = "Fixes.\n\nSHA-256:\n\n```\n$exe  Tally-x64.exe\n$apk  Tally-android.apk\n```\n"
        assertEquals(apk, shaFromNotes(notes, "Tally-android.apk"))
        assertEquals(exe.lowercase(), shaFromNotes(notes, "Tally-x64.exe"))
        assertEquals("", shaFromNotes(notes, "Tally-arm64.exe"))
        assertEquals("", shaFromNotes("$apk  Tally-android.apk.old", "Tally-android.apk")) // the whole name, not a prefix
    }
}
