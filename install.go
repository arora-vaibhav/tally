package main

// Installing without an installer toolkit: Tally-Setup-<arch>.exe is the same program, and
// a "setup" file name (or --install) makes it copy itself to %LOCALAPPDATA%\Programs\Tally,
// add a Start menu entry, make .note files open in Tally, and list itself in Settings >
// Apps for uninstalling. Everything is per user, so no administrator prompt.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	progID       = "Tally.Note"
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Tally`
	homepage     = "https://github.com/arora-vaibhav/tally"
)

var (
	procSHChangeNotify = windows.NewLazySystemDLL("shell32.dll").NewProc("SHChangeNotify")
	procRegDeleteTree  = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegDeleteTreeW")
)

func installDir() string {
	local, _ := os.UserCacheDir() // %LOCALAPPDATA%
	return filepath.Join(local, "Programs", "Tally")
}

func installedExe() string { return filepath.Join(installDir(), "Tally.exe") }

func selfExe() string {
	p, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return p
}

func samePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }

func startMenuLink() string {
	roaming, _ := os.UserConfigDir() // %APPDATA%
	return filepath.Join(roaming, `Microsoft\Windows\Start Menu\Programs`, "Tally.lnk")
}

// wantsInstall: run as Tally-Setup-*.exe, or with --install.
func wantsInstall(args []string) bool {
	for _, a := range args {
		if a == "--install" {
			return true
		}
	}
	return strings.Contains(strings.ToLower(filepath.Base(selfExe())), "setup")
}

// install copies this program into place, registers it and returns the installed path.
func install() (string, error) {
	self, dst := selfExe(), installedExe()
	if !samePath(self, dst) {
		if err := os.MkdirAll(installDir(), 0o755); err != nil {
			return "", err
		}
		old := ""
		if exists(dst) {
			// a running Tally can be renamed but not overwritten; the old file goes on next start
			old = moveAside(dst)
			if old == "" {
				return "", errors.New("could not move the current Tally.exe aside; close Tally and try again")
			}
		}
		if err := copyFile(self, dst); err != nil {
			if old != "" {
				os.Rename(old, dst)
			}
			return "", err
		}
	}
	if err := register(dst); err != nil {
		return "", err
	}
	return dst, makeShortcut(dst)
}

// moveAside renames exe to a fresh exe.old-<pid>-<n> (an earlier .old may still be a
// running image, which Windows will not replace) and returns the new name, or "".
func moveAside(exe string) string {
	removeOld(exe)
	for i := 0; i < 100; i++ {
		p := fmt.Sprintf("%s.old-%d-%d", exe, os.Getpid(), i)
		if os.Rename(exe, p) == nil {
			return p
		}
		if !exists(exe) {
			break
		}
	}
	return ""
}

// removeOld deletes copies that earlier installs and updates moved aside; any still
// running stay until a later start.
func removeOld(exe string) {
	if m, err := filepath.Glob(escapeGlob(exe) + ".old*"); err == nil {
		for _, p := range m {
			os.Remove(p)
		}
	}
}

func escapeGlob(p string) string {
	return strings.NewReplacer("[", "[[]", "*", "[*]", "?", "[?]").Replace(p)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

func setString(path, name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

// register points .note at Tally, offers Tally under "Open with" for .txt, and keeps the
// Settings > Apps entry current. It runs at install and at each start of the installed
// copy, so an update keeps the version shown there right. It reports any change to Explorer.
func register(exe string) error {
	open := `"` + exe + `" "%1"`
	changed := true
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+progID+`\shell\open\command`, registry.QUERY_VALUE); err == nil {
		v, _, _ := k.GetStringValue("")
		k.Close()
		changed = v != open
	}
	values := []struct{ path, name, value string }{
		{`Software\Classes\` + noteExt, "", progID},
		{`Software\Classes\` + noteExt, "Content Type", "text/plain"},
		{`Software\Classes\` + noteExt, "PerceivedType", "text"},
		{`Software\Classes\` + progID, "", "Tally sheet"},
		{`Software\Classes\` + progID + `\DefaultIcon`, "", `"` + exe + `",0`},
		{`Software\Classes\` + progID + `\shell\open\command`, "", open},
		{`Software\Classes\Applications\Tally.exe`, "FriendlyAppName", "Tally"},
		{`Software\Classes\Applications\Tally.exe\shell\open\command`, "", open},
		{`Software\Classes\Applications\Tally.exe\SupportedTypes`, ".txt", ""},
		{`Software\Classes\Applications\Tally.exe\SupportedTypes`, noteExt, ""},
		{`Software\Classes\.txt\OpenWithProgids`, progID, ""}, // listed under Open with; .txt still opens in Notepad
		{uninstallKey, "DisplayName", "Tally"},
		{uninstallKey, "DisplayVersion", strings.TrimPrefix(version, "v")},
		{uninstallKey, "Publisher", "arora-vaibhav"},
		{uninstallKey, "DisplayIcon", exe},
		{uninstallKey, "InstallLocation", filepath.Dir(exe)},
		{uninstallKey, "UninstallString", `"` + exe + `" --uninstall`},
		{uninstallKey, "URLInfoAbout", homepage},
	}
	for _, v := range values {
		if err := setString(v.path, v.name, v.value); err != nil {
			return err
		}
	}
	if k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE); err == nil {
		k.SetDWordValue("NoModify", 1)
		k.SetDWordValue("NoRepair", 1)
		k.Close()
	}
	if changed {
		procSHChangeNotify.Call(0x08000000, 0, 0, 0) // SHCNE_ASSOCCHANGED: Explorer picks up the .note icon
	}
	return nil
}

// makeShortcut writes the Start menu entry through the shell's own scripting object.
func makeShortcut(exe string) error {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + q(startMenuLink()) + ");" +
		"$s.TargetPath=" + q(exe) + ";$s.WorkingDirectory=" + q(filepath.Dir(exe)) + ";" +
		"$s.IconLocation=" + q(exe+",0") + ";$s.Description='Calculator notepad';$s.Save()"
	return hidden(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)).Run()
}

func hidden(c *exec.Cmd) *exec.Cmd {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	return c
}

func deleteTree(path string) {
	p, _ := windows.UTF16PtrFromString(path)
	procRegDeleteTree.Call(uintptr(registry.CURRENT_USER), uintptr(unsafe.Pointer(p)))
}

// uninstall removes what install added. Sheets are never touched.
func uninstall() error {
	exe := selfExe()
	if !samePath(exe, installedExe()) {
		return errors.New("this copy of Tally is not the installed one")
	}
	deleteTree(`Software\Classes\` + progID)
	deleteTree(`Software\Classes\Applications\Tally.exe`)
	deleteTree(uninstallKey)
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+noteExt, registry.QUERY_VALUE); err == nil {
		v, _, _ := k.GetStringValue("")
		k.Close()
		if v == progID {
			deleteTree(`Software\Classes\` + noteExt)
		}
	}
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\.txt\OpenWithProgids`, registry.SET_VALUE); err == nil {
		k.DeleteValue(progID)
		k.Close()
	}
	os.Remove(startMenuLink())
	procSHChangeNotify.Call(0x08000000, 0, 0, 0)
	// The program folder goes once this process has exited: cmd retries for about a minute.
	// CmdLine is passed raw, since Go's argument quoting is not what cmd.exe expects.
	d := installDir()
	c := hidden(exec.Command("cmd.exe"))
	c.SysProcAttr.CmdLine = `cmd.exe /c for /l %i in (1,1,30) do (ping -n 3 127.0.0.1 >nul & rmdir /s /q "` + d + `" 2>nul & if not exist "` + d + `" exit)`
	return c.Start()
}
