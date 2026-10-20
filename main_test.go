package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// The storage layer: plain .txt sheets, unique "(n)" names, creation dates that survive
// renames and reordering, and closing that moves files to Trash instead of deleting them.
func TestSheetStorage(t *testing.T) {
	dir = t.TempDir()
	files = map[string]string{}

	a, err := create("2026-10-14")
	if err != nil || a.Name != "2026-10-14" || a.Created == "" {
		t.Fatalf("first create = %+v, %v", a, err)
	}
	b, _ := create("2026-10-14")
	if b.Name != "2026-10-14 (2)" {
		t.Fatalf("second sheet on the same day = %q, want %q", b.Name, "2026-10-14 (2)")
	}

	if err := save(a.Name, "28 x 1950\nprev x 12"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, a.Name+".note"))
	if string(raw) != "28 x 1950\r\nprev x 12" {
		t.Fatalf("file content = %q, want Windows line endings", raw)
	}

	newName, err := rename(a.Name, "Victoriaville")
	if err != nil || newName != "Victoriaville" {
		t.Fatalf("rename = %q, %v", newName, err)
	}
	if err := order([]string{b.Name, "Victoriaville"}, "Victoriaville"); err != nil {
		t.Fatal(err)
	}

	res, err := load()
	if err != nil || len(res.Sheets) != 2 {
		t.Fatalf("load = %+v, %v", res, err)
	}
	if res.Sheets[0].Name != b.Name || res.Sheets[1].Name != "Victoriaville" || res.Active != "Victoriaville" {
		t.Fatalf("order or active not kept: %+v", res)
	}
	if res.Sheets[1].Created != a.Created {
		t.Fatalf("creation date lost on rename/reorder: got %q, want %q", res.Sheets[1].Created, a.Created)
	}
	if res.Sheets[1].Text != "28 x 1950\nprev x 12" {
		t.Fatalf("text = %q", res.Sheets[1].Text)
	}

	if err := trash(b.Name); err != nil {
		t.Fatal(err)
	}
	if exists(pathOf(b.Name)) {
		t.Fatal("closed sheet still in the sheets folder")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "Trash", "2026-10-14 (2) (closed *).note")); len(m) != 1 {
		t.Fatalf("closed sheet not in Trash: %v", m)
	}

	// a sheet dropped in by hand (or from an older version) gets a backfilled date
	os.WriteFile(filepath.Join(dir, "Notes.txt"), []byte("1+1"), 0o644)
	res, _ = load()
	for _, s := range res.Sheets {
		if s.Created == "" {
			t.Fatalf("sheet %q has no creation date after load", s.Name)
		}
	}
}

// A saved window position is only reused if enough of it lands on a real screen.
func TestVisibleEnough(t *testing.T) {
	work := rect{0, 0, 2880, 1740}
	cases := []struct {
		name string
		win  rect
		want bool
	}{
		{"fully on screen", rect{100, 100, 1100, 800}, true},
		{"mostly off the right edge, still grabbable", rect{2600, 200, 3600, 900}, true},
		{"where an unplugged monitor was", rect{3016, 236, 3959, 907}, false},
		{"title bar above the screen", rect{100, -300, 1100, 400}, false},
		{"a sliver at the left", rect{-990, 100, 10, 800}, false},
	}
	for _, c := range cases {
		if got := visibleEnough(c.win, work); got != c.want {
			t.Errorf("%s: visibleEnough = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestFolderKeyIgnoresCaseAndSlashes(t *testing.T) {
	if folderKey(`C:\Users\V\Documents\Tally`) != folderKey(`c:\users\v\documents\tally\`) {
		t.Fatal("the same folder written two ways should share one lock")
	}
	if folderKey(`C:\a`) == folderKey(`C:\b`) {
		t.Fatal("different folders should not share a lock")
	}
}

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{
		"  a/b:c  ": "a-b-c",
		"...":       "Sheet",
		"Deal: 1 2": "Deal- 1 2",
	} {
		if got := cleanName(in); got != want {
			t.Errorf("cleanName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Switching folders shows only that folder's sheets, is remembered for next launch, and
// keeps a short recent list with the current folder first and no duplicates.
func TestUseFolder(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	settingsFile = filepath.Join(t.TempDir(), "settings.json")
	defer func() { settingsFile = "" }()
	dir = a
	files = map[string]string{}
	create("In A")

	res, err := useFolder(b)
	if err != nil || res.Folder != b || len(res.Sheets) != 0 {
		t.Fatalf("switch to empty folder = %+v, %v", res, err)
	}
	if s := readSettings(); s.Folder != b {
		t.Fatalf("last folder not remembered: %+v", s)
	}
	res, _ = useFolder(a + `\`)
	if len(res.Sheets) != 1 || res.Sheets[0].Name != "In A" {
		t.Fatalf("back in A = %+v", res.Sheets)
	}
	if len(res.Recent) != 2 || folderKey(res.Recent[0]) != folderKey(a) || folderKey(res.Recent[1]) != folderKey(b) {
		t.Fatalf("recent = %v, want A then B once each", res.Recent)
	}
	if _, err := useFolder(filepath.Join(a, "missing")); err == nil || folderKey(dir) != folderKey(a) {
		t.Fatalf("a missing folder should be refused and leave the current one: err %v, dir %s", err, dir)
	}

	var many []string
	for i := 0; i < 20; i++ {
		many = addRecent(many, filepath.Join(`C:\f`, string(rune('a'+i))))
	}
	if len(many) != maxRecent || many[0] != `C:\f\t` {
		t.Fatalf("recent list not capped newest first: %v", many)
	}
}

// Brackets in a folder name are just characters, and a folder another Tally window holds
// is refused without changing the folder in use.
func TestUseFolderEdgeCases(t *testing.T) {
	settingsFile = filepath.Join(t.TempDir(), "settings.json")
	defer func() { settingsFile = "" }()
	home := t.TempDir()
	dir = home
	files = map[string]string{}

	odd := filepath.Join(t.TempDir(), "Notes [old")
	os.MkdirAll(odd, 0o755)
	os.WriteFile(filepath.Join(odd, "Deal.txt"), []byte("1+1"), 0o644)
	res, err := useFolder(odd)
	if err != nil || len(res.Sheets) != 1 || res.Sheets[0].Name != "Deal" {
		t.Fatalf("folder with [ = %+v, %v", res, err)
	}

	busy := t.TempDir()
	name, _ := windows.UTF16PtrFromString(`Local\Tally-folder-` + folderKey(busy))
	h, _ := windows.CreateMutex(nil, false, name) // as if another Tally window had it open
	defer windows.CloseHandle(h)
	if _, err := useFolder(busy); err == nil || folderKey(dir) != folderKey(odd) {
		t.Fatalf("held folder: err %v, dir %s; want refused and still %s", err, dir, odd)
	}
	if s := readSettings(); folderKey(s.Folder) != folderKey(odd) {
		t.Fatalf("a refused switch must not be remembered: %+v", s)
	}
}

// A folder can hold .txt and .note sheets side by side; each keeps its extension through
// rename and close, and opening a file from Explorer shows that file's folder and tab.
func TestNoteAndTxtSheets(t *testing.T) {
	settingsFile = ""
	dir = t.TempDir()
	files = map[string]string{}
	os.WriteFile(filepath.Join(dir, "Old.txt"), []byte("1+1"), 0o644)
	os.WriteFile(filepath.Join(dir, "Deal.note"), []byte("2+2"), 0o644)
	os.WriteFile(filepath.Join(dir, "Deal.txt"), []byte("3+3"), 0o644)
	os.WriteFile(filepath.Join(dir, "readme.md"), []byte("not a sheet"), 0o644)

	res, err := load()
	if err != nil || len(res.Sheets) != 3 {
		t.Fatalf("load = %+v, %v", res.Sheets, err)
	}
	texts := map[string]string{}
	for _, sh := range res.Sheets {
		texts[sh.Name] = sh.Text
	}
	if texts["Old"] != "1+1" || texts["Deal"] != "2+2" || texts["Deal.txt"] != "3+3" {
		t.Fatalf("sheets = %v, want Old, Deal (the .note) and Deal.txt", texts)
	}

	if n, err := rename("Old", "Older"); err != nil || n != "Older" || !exists(filepath.Join(dir, "Older.txt")) {
		t.Fatalf("rename of a .txt sheet = %q, %v; want Older.txt on disk", n, err)
	}
	if err := save("Older", "5"); err != nil || exists(filepath.Join(dir, "Older.note")) {
		t.Fatalf("save after rename wrote the wrong file: %v", err)
	}
	if err := trash("Deal"); err != nil {
		t.Fatal(err)
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "Trash", "Deal (closed *).note")); len(m) != 1 {
		t.Fatalf("closed .note not in Trash with its extension: %v", m)
	}
	if c, _ := create("Deal"); c.Name != "Deal (2)" {
		t.Fatalf("new sheet next to Deal.txt = %q, want Deal (2)", c.Name)
	}

	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "A.note"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(other, "B.txt"), []byte("2"), 0o644)
	res, err = openPath(filepath.Join(other, "B.txt"))
	if err != nil || len(res.Sheets) != 2 || res.Active != "B" || folderKey(res.Folder) != folderKey(other) {
		t.Fatalf("open B.txt = folder %s active %q sheets %d, %v", res.Folder, res.Active, len(res.Sheets), err)
	}
	if got := fileArg([]string{"--after", "12", filepath.Join(other, "A.note")}); got == "" {
		t.Fatal("fileArg missed a .note path")
	}
	if got := fileArg([]string{filepath.Join(other, "nope.note"), filepath.Join(other, "x.pdf")}); got != "" {
		t.Fatalf("fileArg = %q for a missing file and a non-sheet", got)
	}
}

func TestUpdateVersionsAndChecksums(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"v1.3.0", "v1.2.1", true}, {"v1.2.10", "v1.2.9", true}, {"v2.0", "v1.9.9", true},
		{"v1.2.1", "v1.2.1", false}, {"v1.2.0", "v1.2.1", false}, {"v1.3.0", "dev", false}, {"nightly", "v1.0.0", false},
	} {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%s, %s) = %v", c.a, c.b, got)
		}
	}
	h := "F37A6919A8D028C83F55D1E01427D671E7CC6CF25FE2E7379102CD991AF60F4E"
	var rel ghRelease
	rel.Body = "SHA-256:\n\n```\nba7ba82d52db95ec4d32ae0c24f3abc7aed6248460978309d52a4dfee15501a0  Tally-x64.exe\n" + h + "  Tally-arm64.exe\n```"
	if got := expectedSHA(rel, "Tally-arm64.exe"); got != strings.ToLower(h) {
		t.Fatalf("checksum from notes = %q", got)
	}
	rel.Assets = append(rel.Assets, struct {
		Name   string `json:"name"`
		URL    string `json:"browser_download_url"`
		Digest string `json:"digest"`
	}{Name: "Tally-arm64.exe", Digest: "sha256:abc"})
	if got := expectedSHA(rel, "Tally-arm64.exe"); got != "abc" {
		t.Fatalf("GitHub digest should win: %q", got)
	}
	if expectedSHA(rel, "Tally-Setup-arm64.exe") != "" {
		t.Fatal("no checksum should be found for an asset not listed")
	}
}

// The real thing against GitHub: an older build finds the latest release, downloads the
// build for this PC, checks its SHA-256 and swaps it in. Opt in with TALLY_NET_TEST=1.
func TestUpdateFromGitHub(t *testing.T) {
	if os.Getenv("TALLY_NET_TEST") == "" {
		t.Skip("set TALLY_NET_TEST=1 to download the latest release")
	}
	defer func(v string) { version, staged = v, "" }(version)
	version, staged = "v1.0.0", ""
	exe := filepath.Join(t.TempDir(), "Tally.exe")
	os.WriteFile(exe, []byte("old build"), 0o644)
	tag, err := checkUpdate(exe)
	if err != nil || tag == "" {
		t.Fatalf("checkUpdate = %q, %v", tag, err)
	}
	m, _ := filepath.Glob(exe + ".old-*")
	if len(m) != 1 {
		t.Fatalf("the replaced copy should be kept as Tally.exe.old-* until the next start: %v", m)
	}
	if b, _ := os.ReadFile(m[0]); string(b) != "old build" {
		t.Fatal("the moved-aside copy is not the old build")
	}
	if fi, err := os.Stat(exe); err != nil || fi.Size() < 1<<20 {
		t.Fatalf("new build not in place: %v", err)
	}
	t.Logf("updated to %s", tag)
}

// Review fixes: a same-name rename keeps the key the page uses, a .txt in another
// encoding is not offered as a sheet (so it is never rewritten), and an exe can be moved
// aside again while an earlier moved-aside copy still exists.
func TestRenameKeyEncodingAndMoveAside(t *testing.T) {
	settingsFile = ""
	dir = t.TempDir()
	files = map[string]string{}
	os.WriteFile(filepath.Join(dir, "a.b.txt"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(dir, "Latin1.txt"), []byte{'c', 'a', 'f', 0xe9}, 0o644)
	res, _ := load()
	if len(res.Sheets) != 1 || res.Sheets[0].Name != "a.b" {
		t.Fatalf("sheets = %+v, want only a.b (Latin1.txt is not UTF-8)", res.Sheets)
	}
	if n, err := rename("a.b", " a.b "); err != nil || n != "a.b" {
		t.Fatalf("same-name rename = %q, %v", n, err)
	}

	exe := filepath.Join(t.TempDir(), "Tally.exe")
	os.WriteFile(exe, []byte("v1"), 0o644)
	first := moveAside(exe)
	held, _ := os.Open(first) // stands in for a still-running image
	defer held.Close()
	os.WriteFile(exe, []byte("v2"), 0o644)
	if second := moveAside(exe); second == "" || second == first || exists(exe) {
		t.Fatalf("second moveAside = %q (first %q)", second, first)
	}
}
