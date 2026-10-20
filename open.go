package main

// Opening a sheet file from Explorer: Tally switches to the folder the file is in, so its
// neighbours (.txt and .note) come up as tabs, and shows that file's tab. If Tally is
// already open, the new launch hands the path to that window and exits.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// pendingOpen is a file to show once the page loads (Tally was started by opening it).
// pageLoaded turns true at the page's first load; until then an open is applied here.
var (
	pendingOpen string
	pageLoaded  bool
)

// startWith makes p's folder the one in use and p the tab to show, before the page loads.
// Callers hold mu, or run before anything else can.
func startWith(p string) bool {
	if !holdFolder(filepath.Dir(p)) {
		return false
	}
	dir, pendingOpen = filepath.Dir(p), p
	s := readSettings()
	s.Folder, s.Recent = dir, addRecent(s.Recent, dir)
	writeSettings(s)
	return true
}

// fileArg returns the sheet file Tally was asked to open, if any.
func fileArg(args []string) string {
	for _, a := range args {
		if !strings.HasPrefix(a, "--") && isSheetFile(a) {
			if p, err := filepath.Abs(a); err == nil && exists(p) && !isDir(p) {
				return p
			}
		}
	}
	return ""
}

// openPath is the page's binding for a file opened while Tally was running.
func openPath(p string) (loadResult, error) {
	p = filepath.Clean(p)
	mu.Lock()
	pendingOpen = p
	mu.Unlock()
	res, err := useFolder(filepath.Dir(p))
	mu.Lock()
	pendingOpen = ""
	mu.Unlock()
	return res, err
}

func openEventName(key string) *uint16 {
	n, _ := windows.UTF16PtrFromString(`Local\Tally-open-` + key)
	return n
}

// sendToRunning leaves the path for the open window and wakes it. Each launch writes its
// own file, so two files opened at once both arrive.
func sendToRunning(stateDir, key, p string) {
	f := filepath.Join(stateDir, fmt.Sprintf("open-%s-%d.txt", key, os.Getpid()))
	if writeAtomic(f, []byte(p)) != nil {
		return
	}
	if h, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, openEventName(key)); err == nil {
		windows.SetEvent(h)
		windows.CloseHandle(h)
	}
}

// listenForOpens waits for later launches. Before the page has loaded, an opened file
// becomes the folder and tab it starts on; after that, each one goes to the page via out.
func listenForOpens(stateDir, key string, out chan<- string) {
	h, err := windows.CreateEvent(nil, 0, 0, openEventName(key)) // auto-reset
	if err != nil {
		return
	}
	for {
		if ev, _ := windows.WaitForSingleObject(h, windows.INFINITE); ev != windows.WAIT_OBJECT_0 {
			return
		}
		m, _ := filepath.Glob(filepath.Join(escapeGlob(stateDir), "open-"+key+"-*.txt"))
		for _, f := range m {
			b, err := os.ReadFile(f)
			os.Remove(f)
			p := strings.TrimSpace(string(b))
			if err != nil || p == "" {
				continue
			}
			mu.Lock()
			early := !pageLoaded && startWith(p)
			mu.Unlock()
			if !early {
				out <- p
			}
		}
	}
}
