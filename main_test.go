package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// The storage layer: plain .txt sheets, unique "(n)" names, creation dates that survive
// renames and reordering, and closing that moves files to Trash instead of deleting them.
func TestSheetStorage(t *testing.T) {
	dir = t.TempDir()

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
	raw, _ := os.ReadFile(filepath.Join(dir, a.Name+".txt"))
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
	if m, _ := filepath.Glob(filepath.Join(dir, "Trash", "2026-10-14 (2) (closed *).txt")); len(m) != 1 {
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
