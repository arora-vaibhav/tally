package main

// The sheets folder in use. Tally shows the sheets of one folder at a time, remembers the
// last one used, and keeps a short list of recent folders to switch between. Choosing a
// new one uses the standard Windows folder picker.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maxRecent = 8

// settingsFile holds settings-<key>.json in %LOCALAPPDATA%\Tally; empty means not saved (tests).
var settingsFile string

type settings struct {
	Folder string   `json:"folder"` // the folder last in use
	Recent []string `json:"recent"` // most recent first
}

func isDir(p string) bool { fi, err := os.Stat(p); return err == nil && fi.IsDir() }

func readSettings() settings {
	var s settings
	if settingsFile != "" {
		if b, err := os.ReadFile(settingsFile); err == nil {
			json.Unmarshal(b, &s)
		}
	}
	return s
}

func writeSettings(s settings) error {
	if settingsFile == "" {
		return nil
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeAtomic(settingsFile, b)
}

// addRecent puts folder first, drops other spellings of it, and caps the list.
func addRecent(list []string, folder string) []string {
	out := []string{folder}
	for _, f := range list {
		if folderKey(f) != folderKey(folder) && len(out) < maxRecent {
			out = append(out, f)
		}
	}
	return out
}

// recentFolders is the switch list for the page: the current folder first, then the
// others that still exist. Callers hold mu.
func recentFolders() []string {
	var out []string
	for _, f := range addRecent(readSettings().Recent, dir) {
		if folderKey(f) == folderKey(dir) || isDir(f) {
			out = append(out, f)
		}
	}
	return out
}

// useFolder switches Tally to the sheets in folder and remembers it for next time. On any
// failure the folder in use stays as it was, so the page and the saves never disagree.
func useFolder(folder string) (loadResult, error) {
	folder = filepath.Clean(folder)
	if !filepath.IsAbs(folder) || !isDir(folder) {
		return loadResult{}, fmt.Errorf("folder not found: %s", folder)
	}
	mu.Lock()
	defer mu.Unlock()
	if folderKey(folder) != folderKey(dir) && !holdFolder(folder) {
		return loadResult{}, fmt.Errorf("%s is open in another Tally window", filepath.Base(folder))
	}
	old := dir
	dir = folder
	res, err := loadLocked()
	if err == nil {
		s := readSettings()
		s.Folder, s.Recent = folder, addRecent(s.Recent, folder)
		if err = writeSettings(s); err == nil {
			res.Recent = recentFolders()
			return res, nil
		}
	}
	dir = old
	holdFolder(old)
	loadLocked() // files must describe the folder in use again
	return loadResult{}, err
}

// folderLock is a named mutex for the folder in use, so two Tally windows (say one started
// with TALLY_DIR) never edit the same sheets.
var (
	folderLock    windows.Handle
	folderLockKey string
)

// holdFolder takes the lock for folder and releases the previous one. It reports false,
// keeping the previous lock, when another Tally already has that folder open.
func holdFolder(folder string) bool {
	key := folderKey(folder)
	if folderLock != 0 && key == folderLockKey {
		return true
	}
	name, _ := windows.UTF16PtrFromString(`Local\Tally-folder-` + key)
	h, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		if h != 0 {
			windows.CloseHandle(h) // ERROR_ALREADY_EXISTS: another Tally holds it
		}
		return false
	}
	if folderLock != 0 {
		windows.CloseHandle(folderLock)
	}
	folderLock, folderLockKey = h, key
	return true
}

// chooseFolder shows the folder picker; nil means the user cancelled.
func chooseFolder() (*loadResult, error) {
	mu.Lock()
	start := dir
	mu.Unlock()
	p, err := pickFolder(mainWindow, start)
	if err != nil || p == "" {
		return nil, err
	}
	r, err := useFolder(p)
	return &r, err
}

// ---- Windows folder picker (IFileOpenDialog with FOS_PICKFOLDERS) ----------------------

var (
	mainWindow uintptr // owner of the picker, so it is modal to Tally

	procCoCreateInstance            = windows.NewLazySystemDLL("ole32.dll").NewProc("CoCreateInstance")
	procCoTaskMemFree               = windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemFree")
	procSHCreateItemFromParsingName = windows.NewLazySystemDLL("shell32.dll").NewProc("SHCreateItemFromParsingName")

	clsidFileOpenDialog = windows.GUID{Data1: 0xDC1C5A9C, Data2: 0xE88A, Data3: 0x4DDE, Data4: [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidIFileOpenDialog  = windows.GUID{Data1: 0xD57C7288, Data2: 0xD4AD, Data3: 0x4768, Data4: [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
	iidIShellItem       = windows.GUID{Data1: 0x43826D1E, Data2: 0xE718, Data3: 0x42EE, Data4: [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}
)

// vtable slots used below (IUnknown, IModalWindow, IFileDialog, IShellItem)
const (
	slotRelease        = 2
	slotShow           = 3
	slotSetOptions     = 9
	slotGetOptions     = 10
	slotSetFolder      = 12
	slotSetTitle       = 17
	slotSetOkLabel     = 18
	slotGetResult      = 20
	slotGetDisplayName = 5 // IShellItem

	fosPickFolders     = 0x20
	fosForceFileSystem = 0x40
	sigdnFileSysPath   = 0x80058000
	errCancelled       = 0x800704C7 // HRESULT_FROM_WIN32(ERROR_CANCELLED)
)

// uintptrescapes keeps the out-parameters callers pass (&opts, &item, &name) off the stack,
// which the runtime may move while COM still holds their address.
//
//go:uintptrescapes
func comCall(obj unsafe.Pointer, slot int, args ...uintptr) uint32 {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, slot*int(unsafe.Sizeof(uintptr(0)))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return uint32(r)
}

// pickFolder runs on the window's thread (bindings are called there, with COM already
// initialised by WebView2). It returns "" when the user cancels.
func pickFolder(owner uintptr, start string) (string, error) {
	var dlg unsafe.Pointer
	if hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, 1, // CLSCTX_INPROC_SERVER
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)), uintptr(unsafe.Pointer(&dlg))); uint32(hr) != 0 {
		return "", fmt.Errorf("cannot open the folder picker (%08x)", uint32(hr))
	}
	defer comCall(dlg, slotRelease)

	var opts uint32
	comCall(dlg, slotGetOptions, uintptr(unsafe.Pointer(&opts)))
	comCall(dlg, slotSetOptions, uintptr(opts|fosPickFolders|fosForceFileSystem))
	title, _ := windows.UTF16PtrFromString("Choose a sheets folder")
	ok, _ := windows.UTF16PtrFromString("Use this folder")
	comCall(dlg, slotSetTitle, uintptr(unsafe.Pointer(title)))
	comCall(dlg, slotSetOkLabel, uintptr(unsafe.Pointer(ok)))
	if p, err := windows.UTF16PtrFromString(start); err == nil && start != "" {
		var item unsafe.Pointer
		if hr, _, _ := procSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(p)), 0,
			uintptr(unsafe.Pointer(&iidIShellItem)), uintptr(unsafe.Pointer(&item))); uint32(hr) == 0 {
			comCall(dlg, slotSetFolder, uintptr(item))
			comCall(item, slotRelease)
		}
		runtime.KeepAlive(p)
	}
	runtime.KeepAlive(title)
	runtime.KeepAlive(ok)

	switch hr := comCall(dlg, slotShow, owner); hr {
	case 0:
	case errCancelled:
		return "", nil
	default:
		return "", fmt.Errorf("folder picker failed (%08x)", hr)
	}

	var item unsafe.Pointer
	if hr := comCall(dlg, slotGetResult, uintptr(unsafe.Pointer(&item))); hr != 0 {
		return "", fmt.Errorf("folder picker gave no folder (%08x)", hr)
	}
	defer comCall(item, slotRelease)
	var name *uint16
	if hr := comCall(item, slotGetDisplayName, sigdnFileSysPath, uintptr(unsafe.Pointer(&name))); hr != 0 {
		return "", fmt.Errorf("that is not a folder on disk (%08x)", hr)
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(name)))
	return strings.TrimSpace(windows.UTF16PtrToString(name)), nil
}
