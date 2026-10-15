package main

// Window behaviour that makes Tally feel like a desktop app rather than a page:
// one copy per sheets folder, and the window reopening where it was left, but never
// off-screen when a monitor has since been unplugged.

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procGetWindowPlacement  = user32.NewProc("GetWindowPlacement")
	procSetWindowPlacement  = user32.NewProc("SetWindowPlacement")
	procMonitorFromRect     = user32.NewProc("MonitorFromRect")
	procGetMonitorInfo      = user32.NewProc("GetMonitorInfoW")
	procIsWindow            = user32.NewProc("IsWindow")
	procIsIconic            = user32.NewProc("IsIconic")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")

	instanceLock windows.Handle // held for the life of the process
)

const (
	swShowNormal    = 1
	swShowMinimized = 2
	swShowMaximized = 3
	swRestore       = 9
	wpfRestoreToMax = 2
	monitorNull     = 0
)

type rect struct{ Left, Top, Right, Bottom int32 }

type windowPlacement struct {
	Length         uint32
	Flags          uint32
	ShowCmd        uint32
	MinPosition    struct{ X, Y int32 }
	MaxPosition    struct{ X, Y int32 }
	NormalPosition rect
}

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

// savedWindow is what window-<key>.json holds.
type savedWindow struct {
	Left, Top, Right, Bottom int32
	Maximized                bool
}

// folderKey ties the single-instance lock and the window state to one sheets folder,
// so a copy pointed elsewhere with TALLY_DIR can run alongside.
func folderKey(folder string) string {
	h := sha1.Sum([]byte(strings.ToLower(filepath.Clean(folder))))
	return hex.EncodeToString(h[:6])
}

// firstInstance takes the lock for this sheets folder. If another Tally already holds it,
// that window is brought to the front and false is returned so this copy can exit.
func firstInstance(stateDir, key string) bool {
	name, _ := windows.UTF16PtrFromString(`Local\Tally-` + key)
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		if b, err := os.ReadFile(filepath.Join(stateDir, "window-"+key+".hwnd")); err == nil {
			if v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64); err == nil {
				hwnd := uintptr(v)
				if ok, _, _ := procIsWindow.Call(hwnd); ok != 0 {
					if min, _, _ := procIsIconic.Call(hwnd); min != 0 {
						procShowWindow.Call(hwnd, swRestore)
					}
					procSetForegroundWindow.Call(hwnd)
				}
			}
		}
		return false
	}
	instanceLock = h
	return true
}

// visibleEnough reports whether a window rect overlaps a monitor's work area by enough
// to see and grab it: at least 120 x 60 pixels, title bar included.
func visibleEnough(win, work rect) bool {
	w := min32(win.Right, work.Right) - max32(win.Left, work.Left)
	h := min32(win.Bottom, work.Bottom) - max32(win.Top, work.Top)
	return w >= 120 && h >= 60 && win.Top >= work.Top-8
}

// restoreWindow puts the window back where it was last time, if that spot is still on a
// connected monitor. Otherwise it leaves the centred default.
func restoreWindow(hwnd uintptr, file string) {
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var s savedWindow
	if json.Unmarshal(b, &s) != nil || s.Right-s.Left < 300 || s.Bottom-s.Top < 200 {
		return
	}
	r := rect{s.Left, s.Top, s.Right, s.Bottom}
	mon, _, _ := procMonitorFromRect.Call(uintptr(unsafe.Pointer(&r)), monitorNull)
	if mon == 0 {
		return // the monitor it was on is gone
	}
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if ok, _, _ := procGetMonitorInfo.Call(mon, uintptr(unsafe.Pointer(&mi))); ok == 0 || !visibleEnough(r, mi.Work) {
		return
	}
	wp := windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{})), NormalPosition: r, ShowCmd: swShowNormal}
	if s.Maximized {
		wp.ShowCmd = swShowMaximized
	}
	procSetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp)))
}

// trackWindow saves the window's normal position and maximised state whenever they change.
// It polls rather than hooking the window procedure, which the webview library owns.
func trackWindow(hwnd uintptr, file string) {
	var last savedWindow
	for range time.Tick(1500 * time.Millisecond) {
		if ok, _, _ := procIsWindow.Call(hwnd); ok == 0 {
			return
		}
		wp := windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{}))}
		if ok, _, _ := procGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp))); ok == 0 {
			continue
		}
		s := savedWindow{
			Left: wp.NormalPosition.Left, Top: wp.NormalPosition.Top,
			Right: wp.NormalPosition.Right, Bottom: wp.NormalPosition.Bottom,
			Maximized: wp.ShowCmd == swShowMaximized || (wp.ShowCmd == swShowMinimized && wp.Flags&wpfRestoreToMax != 0),
		}
		if s == last {
			continue
		}
		last = s
		if b, err := json.Marshal(s); err == nil {
			writeAtomic(file, b)
		}
	}
}

func min32(a, b int32) int32 {
	if a < b {
		return a
	}
	return b
}

func max32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}
