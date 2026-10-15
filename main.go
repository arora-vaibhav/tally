// Tally: a small local calculator notepad with tabs, in a native WebView2 window.
//
// Each tab is a plain .txt file in Documents\Tally, so sheets survive anything that
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
	Sheets []sheet `json:"sheets"`
	Active string  `json:"active"`
	Folder string  `json:"folder"`
}

var (
	dir string
	mu  sync.Mutex
)

func main() {
	docs, err := windows.KnownFolderPath(windows.FOLDERID_Documents, 0)
	if err != nil || docs == "" {
		home, _ := os.UserHomeDir()
		docs = filepath.Join(home, "Documents")
	}
	dir = filepath.Join(docs, "Tally")
	if d := os.Getenv("TALLY_DIR"); d != "" {
		dir = d // keep sheets somewhere else, e.g. a synced folder or a portable copy
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal("Cannot create the sheets folder " + dir + ": " + err.Error())
	}

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

	local, _ := os.UserCacheDir()
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
	styleTitleBar(uintptr(w.Window()), dark)

	w.Bind("tallyLoad", load)
	w.Bind("tallySave", save)
	w.Bind("tallyCreate", create)
	w.Bind("tallyRename", rename)
	w.Bind("tallyTrash", trash)
	w.Bind("tallyOrder", order)
	w.Bind("tallyOpenFolder", func() { exec.Command("explorer.exe", dir).Start() })

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

func pathOf(name string) string { return filepath.Join(dir, cleanName(name)+".txt") }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// uniqueName returns name, or "name (2)", "name (3)"... whichever has no file yet.
func uniqueName(name string) string {
	base := cleanName(name)
	n := base
	for i := 2; exists(pathOf(n)); i++ {
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
	files, err := filepath.Glob(filepath.Join(dir, "*.txt"))
	if err != nil {
		return loadResult{}, err
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
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".txt")
		b, err := os.ReadFile(f)
		if err != nil {
			continue
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
	return loadResult{Sheets: out, Active: st.Active, Folder: dir}, nil
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
	if err := writeAtomic(pathOf(n), nil); err != nil {
		return created{}, err
	}
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
		return cleanName(oldName), nil
	}
	n := uniqueName(newName)
	if err := os.Rename(pathOf(oldName), pathOf(n)); err != nil {
		return oldName, err
	}
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
	dst := filepath.Join(bin, fmt.Sprintf("%s (closed %s).txt", cleanName(name), time.Now().Format("2006-01-02 1504")))
	return os.Rename(src, dst)
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
