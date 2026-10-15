package main

import (
	"os"
	"path/filepath"
	"testing"
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
