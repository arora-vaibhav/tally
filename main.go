// Tally: a small local calculator notepad with tabs, in a native WebView2 window.
//
// Each tab is a plain .txt file in the sheets folder (Documents\Tally unless another
// folder was chosen; the last one used is remembered), so sheets survive anything that
// happens to the app and can be opened in any editor. Closing a tab moves its file
// to Documents\Tally\Trash; nothing is ever deleted. _tabs.json keeps tab order and
// the active tab.
//
// Build:  go build -ldflags "-H windowsgui" -o Tally.exe .
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed web
var webFS embed.FS

type sheet struct {
	Name    string `json:"name"`
	Text    string `json:"text"`
	Created string `json:"created"` // RFC 3339; kept in _tabs.json because every save replaces the file
}

type tabState struct {
	Order   []string          `json:"order"`
	Active  string            `json:"active"`
	Created map[string]string `json:"created,omitempty"` // sheet name -> when it was first created
}

type loadResult struct {
	Sheets []sheet  `json:"sheets"`
	Active string   `json:"active"`
	Folder string   `json:"folder"`
	Recent []string `json:"recent"` // folders to switch between, the current one first
}

var (
	dir string
	mu  sync.Mutex
)

// defaultDir is Documents\Tally, or TALLY_DIR to keep sheets somewhere else.
func defaultDir() string {
	if d := os.Getenv("TALLY_DIR"); d != "" {
		return d
	}
	docs, err := windows.KnownFolderPath(windows.FOLDERID_Documents, 0)
	if err != nil || docs == "" {
		home, _ := os.UserHomeDir()
		docs = filepath.Join(home, "Documents")
	}
	return filepath.Join(docs, "Tally")
}

// tallyRunning reports whether a Tally window is open (it holds the instance lock).
func tallyRunning() bool {
	name, _ := windows.UTF16PtrFromString(`Local\Tally-` + folderKey(defaultDir()))
	h, err := windows.CreateMutex(nil, false, name)
	if h != 0 {
		windows.CloseHandle(h)
	}
	return err == windows.ERROR_ALREADY_EXISTS
}

func message(text string, flags uint32) int32 {
	r, _ := windows.MessageBox(0, windows.StringToUTF16Ptr(text), windows.StringToUTF16Ptr("Tally"), flags)
	return r
}

func main() {
	args := os.Args[1:]
	for _, a := range args {
		if a == "--uninstall" {
			if tallyRunning() {
				message("Close Tally first, then uninstall it again.", windows.MB_ICONINFORMATION)
			} else if message("Remove Tally from this PC?\n\nYour sheets stay where they are.", windows.MB_YESNO|windows.MB_ICONQUESTION) == 6 { // IDYES
				if err := uninstall(); err != nil {
					fatal("Could not uninstall Tally: " + err.Error())
				}
				message("Tally has been removed. Your sheets are still in "+defaultDir()+".", windows.MB_ICONINFORMATION)
			}
			return
		}
	}
	if wantsInstall(args) {
		wasRunning := tallyRunning()
		exe, err := install()
		if err != nil {
			fatal("Could not install Tally: " + err.Error())
		}
		msg := "Tally " + strings.TrimPrefix(version, "v") + " is installed.\n\nOpen it from the Start menu. Files ending in .note open in Tally, and Tally updates itself when a new version comes out."
		if wasRunning {
			msg += "\n\nTally is open now: close it and open it again to use this version."
		}
		message(msg, windows.MB_ICONINFORMATION)
		if !wasRunning {
			exec.Command(exe).Start()
		}
		return
	}
	waitForExit(args)        // a restart after an update
	removeOld(selfExe())     // copies an update or reinstall replaced
	opening := fileArg(args) // a .note or .txt opened from Explorer

	dir = defaultDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal("Cannot create the sheets folder " + dir + ": " + err.Error())
	}

	local, _ := os.UserCacheDir()
	stateDir := filepath.Join(local, "Tally")
	os.MkdirAll(stateDir, 0o755)
	// The lock, window position and settings are keyed to the default folder, not the one
	// in use, so switching folders never lets a second copy open.
	key := folderKey(dir)
	settingsFile = filepath.Join(stateDir, "settings-"+key+".json")
	if !firstInstance(stateDir, key) {
		// Tally is already open and has been brought forward; it takes over the file, if any
		if opening != "" {
			sendToRunning(stateDir, key, opening)
		}
		return
	}
	if last := readSettings().Folder; opening != "" && startWith(opening) {
		// the folder of the file opened from Explorer
	} else if last != "" && isDir(last) && holdFolder(last) {
		dir = last
	} else {
		holdFolder(dir)
	}
	if samePath(selfExe(), installedExe()) {
		go register(installedExe()) // keeps the .note link and the version in Settings > Apps current
	}
	opens := make(chan string, 8)
	go listenForOpens(stateDir, key, opens) // listening before the window exists, so no open is missed

	sub, _ := fs.Sub(webFS, "web")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal("Cannot start the local page server: " + err.Error())
	}
	go http.Serve(ln, noCache(http.FileServer(http.FS(sub))))

	dark := systemDark()
	if dark {
		// The window background shown before the page paints, so there is no white flash.
		os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF151515")
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  filepath.Join(local, "Tally", "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title:  "Tally",
			Width:  980,
			Height: 680,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		fatal("Could not open the window. Microsoft Edge WebView2 Runtime is required.")
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	mainWindow = hwnd
	styleTitleBar(hwnd, dark)

	// Reopen where it was left (only if that spot is still on a monitor), keep tracking it,
	// and leave the handle where a second launch can find it and bring this window forward.
	winFile := filepath.Join(stateDir, "window-"+key+".json")
	restoreWindow(hwnd, winFile)
	go trackWindow(hwnd, winFile)
	os.WriteFile(filepath.Join(stateDir, "window-"+key+".hwnd"), []byte(fmt.Sprint(hwnd)), 0o644)

	w.Bind("tallyLoad", load)
	w.Bind("tallySave", save)
	w.Bind("tallyCreate", create)
	w.Bind("tallyRename", rename)
	w.Bind("tallyTrash", trash)
	w.Bind("tallyOrder", order)
	w.Bind("tallyOpenFolder", func() {
		mu.Lock()
		d := dir
		mu.Unlock()
		exec.Command("explorer.exe", d).Start()
	})
	w.Bind("tallyChooseFolder", chooseFolder)
	w.Bind("tallyUseFolder", useFolder)
	w.Bind("tallyOpenPath", openPath)
	w.Bind("tallyVersion", func() string { return version })
	w.Bind("tallyRestart", func() error {
		if err := restart(); err != nil {
			return err
		}
		w.Terminate()
		return nil
	})
	run := func(js string) { w.Dispatch(func() { w.Eval(js) }) }
	go func() {
		for p := range opens {
			arg, _ := json.Marshal(p)
			run("window.tallyFileOpened && window.tallyFileOpened(" + string(arg) + ")")
		}
	}()
	go watchForUpdates(func(tag string) {
		arg, _ := json.Marshal(tag)
		run("window.tallyUpdateReady && window.tallyUpdateReady(" + string(arg) + ")")
	})

	// Exchange rates: the page asks for whatever is cached, and a background fetch refreshes
	// the cache and tells the page when newer rates arrive. The window never waits on the network.
	ratesFile = filepath.Join(local, "Tally", "rates.json")
	w.Bind("tallyRates", cachedRates)
	go func() {
		if refreshRates() {
			w.Dispatch(func() { w.Eval("window.tallyRatesUpdated && window.tallyRatesUpdated()") })
		}
	}()

	w.Navigate(fmt.Sprintf("http://%s/index.html", ln.Addr().String()))
	w.Run()
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(rw, r)
	})
}

// ---- file helpers ----------------------------------------------------------

func cleanName(n string) string {
	n = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '-'
		}
		return r
	}, strings.TrimSpace(n))
	n = strings.Trim(n, ". ")
	if len([]rune(n)) > 80 {
		n = string([]rune(n)[:80])
	}
	if n == "" {
		n = "Sheet"
	}
	return n
}

// Sheets are .note files (Tally's own, so a double-click opens Tally) or plain .txt files.
// files maps each sheet name shown in a tab to its file name in dir; callers hold mu.
const noteExt = ".note"

var files = map[string]string{}

func isSheetFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".txt" || ext == noteExt
}

func pathOf(name string) string {
	if f, ok := files[name]; ok {
		return filepath.Join(dir, f)
	}
	return filepath.Join(dir, cleanName(name)+noteExt)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// uniqueName returns name, or "name (2)", "name (3)"... whichever has no file yet.
func uniqueName(name string) string {
	base := cleanName(name)
	n := base
	taken := func(n string) bool {
		_, ok := files[n]
		return ok || exists(filepath.Join(dir, n+".txt")) || exists(filepath.Join(dir, n+noteExt))
	}
	for i := 2; taken(n); i++ {
		n = fmt.Sprintf("%s (%d)", base, i)
	}
	return n
}

func readState() tabState {
	var s tabState
	if b, err := os.ReadFile(filepath.Join(dir, "_tabs.json")); err == nil {
		json.Unmarshal(b, &s)
	}
	return s
}

func writeState(s tabState) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeAtomic(filepath.Join(dir, "_tabs.json"), b)
}

// writeAtomic writes via a temp file and rename, so a crash never leaves half a sheet.
func writeAtomic(p string, b []byte) error {
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// ---- bindings ----------------------------------------------------------------

func load() (loadResult, error) {
	mu.Lock()
	defer mu.Unlock()
	pageLoaded = true
	return loadLocked()
}

// loadLocked reads the sheets in dir; callers hold mu.
func loadLocked() (loadResult, error) {
	entries, err := os.ReadDir(dir) // not filepath.Glob, which reads [ ] in a folder name as a pattern
	if err != nil {
		return loadResult{}, err
	}
	found := map[string]string{} // name -> file, built fresh so a failed load leaves files alone
	var paths []string
	for _, e := range entries {
		if e.IsDir() || !isSheetFile(e.Name()) {
			continue
		}
		name := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		if _, dup := found[name]; dup {
			name = e.Name() // "Deal.note" next to "Deal.txt": show the second with its extension
		}
		found[name] = e.Name()
		paths = append(paths, name)
	}
	st := readState()
	rank := map[string]int{}
	for i, n := range st.Order {
		rank[n] = i
	}
	var out []sheet
	backfilled := false
	if st.Created == nil {
		st.Created = map[string]string{}
	}
	for _, name := range paths {
		f := filepath.Join(dir, found[name])
		b, err := os.ReadFile(f)
		if err != nil || !utf8.Valid(b) {
			continue // a .txt in another encoding is left alone rather than rewritten as UTF-8
		}
		created, ok := st.Created[name]
		if !ok {
			// sheets from before dates were tracked: the best evidence is when the file was last written
			if fi, err := os.Stat(f); err == nil {
				created = fi.ModTime().Format(time.RFC3339)
				st.Created[name] = created
				backfilled = true
			}
		}
		out = append(out, sheet{Name: name, Text: strings.ReplaceAll(string(b), "\r\n", "\n"), Created: created})
	}
	if backfilled {
		writeState(st)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, iok := rank[out[i].Name]
		rj, jok := rank[out[j].Name]
		switch {
		case iok && jok:
			return ri < rj
		case iok != jok:
			return iok // known order first, new files after
		default:
			return out[i].Name < out[j].Name
		}
	})
	files = found
	active := st.Active
	if pendingOpen != "" { // a file Tally was asked to open: show its tab
		for n, f := range files {
			if strings.EqualFold(f, filepath.Base(pendingOpen)) && folderKey(filepath.Dir(pendingOpen)) == folderKey(dir) {
				active = n
			}
		}
		pendingOpen = ""
	}
	return loadResult{Sheets: out, Active: active, Folder: dir, Recent: recentFolders()}, nil
}

func save(name, text string) error {
	mu.Lock()
	defer mu.Unlock()
	return writeAtomic(pathOf(name), []byte(strings.ReplaceAll(text, "\n", "\r\n")))
}

type created struct {
	Name    string `json:"name"`
	Created string `json:"created"`
}

func create(name string) (created, error) {
	mu.Lock()
	defer mu.Unlock()
	n := uniqueName(name)
	if err := writeAtomic(filepath.Join(dir, n+noteExt), nil); err != nil {
		return created{}, err
	}
	files[n] = n + noteExt
	now := time.Now().Format(time.RFC3339)
	st := readState()
	if st.Created == nil {
		st.Created = map[string]string{}
	}
	st.Created[n] = now
	return created{Name: n, Created: now}, writeState(st)
}

func rename(oldName, newName string) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if cleanName(newName) == cleanName(oldName) {
		return oldName, nil // the tab keeps the name its file is known by
	}
	n := uniqueName(newName)
	src := pathOf(oldName)
	f := n + filepath.Ext(src) // a renamed sheet keeps its .txt or .note
	if err := os.Rename(src, filepath.Join(dir, f)); err != nil {
		return oldName, err
	}
	delete(files, oldName)
	files[n] = f
	// the creation date follows the sheet to its new name
	st := readState()
	if c, ok := st.Created[oldName]; ok {
		delete(st.Created, oldName)
		st.Created[n] = c
		writeState(st)
	}
	return n, nil
}

func trash(name string) error {
	mu.Lock()
	defer mu.Unlock()
	src := pathOf(name)
	if !exists(src) {
		return nil
	}
	bin := filepath.Join(dir, "Trash")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return err
	}
	base := filepath.Base(src)
	ext := filepath.Ext(base)
	dst := filepath.Join(bin, fmt.Sprintf("%s (closed %s)%s", strings.TrimSuffix(base, ext), time.Now().Format("2006-01-02 1504"), ext))
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	delete(files, name)
	return nil
}

func order(names []string, active string) error {
	mu.Lock()
	defer mu.Unlock()
	st := readState() // keep the creation dates
	st.Order, st.Active = names, active
	return writeState(st)
}

// ---- exchange rates ------------------------------------------------------------

var ratesFile string

type rates struct {
	Base    string             `json:"base"`
	Date    string             `json:"date"`
	Rates   map[string]float64 `json:"rates"`
	Fetched time.Time          `json:"fetched"`
	Source  string             `json:"source"`
}

func cachedRates() (*rates, error) {
	b, err := os.ReadFile(ratesFile)
	if err != nil {
		return nil, nil // no cache yet; the page shows currencies once the fetch lands
	}
	var r rates
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, nil
	}
	return &r, nil
}

// refreshRates fetches ECB reference rates (via Frankfurter, no key) when the cache is
// missing or older than 12 hours. It reports whether the cache changed.
func refreshRates() bool {
	if r, _ := cachedRates(); r != nil && time.Since(r.Fetched) < 12*time.Hour {
		return false
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://api.frankfurter.dev/v1/latest?base=USD")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var r rates
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r.Base == "" || len(r.Rates) == 0 {
		return false
	}
	r.Fetched = time.Now()
	r.Source = "European Central Bank via frankfurter.dev"
	b, _ := json.MarshalIndent(r, "", "  ")
	if err := os.MkdirAll(filepath.Dir(ratesFile), 0o755); err != nil {
		return false
	}
	return writeAtomic(ratesFile, b) == nil
}

// ---- window chrome -------------------------------------------------------------

// systemDark reports whether Windows apps are set to dark mode.
func systemDark() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err == nil && v == 0
}

// styleTitleBar paints the caption to match the page instead of the default white bar.
func styleTitleBar(hwnd uintptr, dark bool) {
	dwm := windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")
	set := func(attr uint32, v uint32) { dwm.Call(hwnd, uintptr(attr), uintptr(unsafe.Pointer(&v)), 4) }
	const (
		useImmersiveDarkMode = 20
		borderColor          = 34
		captionColor         = 35
	)
	// COLORREF is 0x00BBGGRR.
	caption := uint32(0x00F5F7F7) // #f7f7f5
	if dark {
		set(useImmersiveDarkMode, 1)
		caption = 0x00151515 // #151515, the same near-black as the Claude app
	}
	set(captionColor, caption)
	set(borderColor, caption)
}

func fatal(msg string) {
	log.Print(msg)
	windows.MessageBox(0, windows.StringToUTF16Ptr(msg), windows.StringToUTF16Ptr("Tally"), windows.MB_ICONERROR)
	os.Exit(1)
}
