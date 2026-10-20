package main

// Updates: a release build (version set at build time) checks the latest GitHub release at
// start and every 12 hours. A newer build for this PC is downloaded, checked against the
// SHA-256 GitHub publishes for it, and swapped in beside the running copy (Windows lets a
// running .exe be renamed, not overwritten). The page then offers a restart.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// version is set by the release build: -ldflags "-X main.version=v1.3.0". "dev" never updates.
var version = "dev"

const latestURL = "https://api.github.com/repos/arora-vaibhav/tally/releases/latest"

type ghRelease struct {
	Tag    string `json:"tag_name"`
	Body   string `json:"body"`
	Assets []struct {
		Name   string `json:"name"`
		URL    string `json:"browser_download_url"`
		Digest string `json:"digest"` // "sha256:<hex>"
	} `json:"assets"`
}

func assetName() string {
	if runtime.GOARCH == "arm64" {
		return "Tally-arm64.exe"
	}
	return "Tally-x64.exe"
}

// parseVersion reads "v1.2.3" (or "1.2"); ok is false for anything else, such as "dev".
func parseVersion(v string) (n [3]int, ok bool) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
	if len(parts) < 2 || len(parts) > 3 {
		return n, false
	}
	for i, p := range parts {
		x, err := strconv.Atoi(p)
		if err != nil || x < 0 {
			return n, false
		}
		n[i] = x
	}
	return n, true
}

// newer reports whether release tag a is a later version than b.
func newer(a, b string) bool {
	x, ok1 := parseVersion(a)
	y, ok2 := parseVersion(b)
	if !ok1 || !ok2 {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}

// expectedSHA finds the published checksum for an asset: GitHub's own digest, or the
// "<hex>  <file>" line in the release notes for releases made before digests existed.
func expectedSHA(rel ghRelease, name string) string {
	for _, a := range rel.Assets {
		if a.Name == name && strings.HasPrefix(a.Digest, "sha256:") {
			return strings.ToLower(strings.TrimPrefix(a.Digest, "sha256:"))
		}
	}
	m := regexp.MustCompile(`(?mi)^\s*([0-9a-f]{64})\s+\*?` + regexp.QuoteMeta(name) + `\s*$`).FindStringSubmatch(rel.Body)
	if m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

var updateClient = &http.Client{Timeout: 5 * time.Minute}

// staged is the version already swapped in and waiting for a restart.
var staged string

// checkUpdate installs a newer release over exe (the running copy) and returns its tag, or "".
func checkUpdate(exe string) (string, error) {
	if staged != "" {
		return staged, nil
	}
	if _, ok := parseVersion(version); !ok {
		return "", nil // a development build
	}
	req, _ := http.NewRequest("GET", latestURL, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Tally/"+version)
	resp, err := updateClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("release check: %s", resp.Status)
	}
	var rel ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return "", err
	}
	if !newer(rel.Tag, version) {
		return "", nil
	}
	url := ""
	for _, a := range rel.Assets {
		if a.Name == assetName() {
			url = a.URL
		}
	}
	want := expectedSHA(rel, assetName())
	if url == "" || want == "" {
		return "", errors.New("release has no build or checksum for this PC")
	}

	tmp := exe + ".new"
	if err := download(url, tmp, want); err != nil {
		os.Remove(tmp)
		return "", err
	}
	old := moveAside(exe)
	if old == "" {
		os.Remove(tmp)
		return "", errors.New("cannot replace " + exe) // e.g. installed somewhere this user cannot write
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe)
		return "", err
	}
	staged = rel.Tag
	return rel.Tag, nil
}

func download(url, dst, wantSHA string) error {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Tally/"+version)
	resp, err := updateClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: %s", resp.Status)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, 200<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		return fmt.Errorf("download checksum %s does not match the release (%s)", got, wantSHA)
	}
	return nil
}

// watchForUpdates checks now and every 12 hours, and tells the page once one is ready.
func watchForUpdates(ready func(tag string)) {
	time.Sleep(5 * time.Second) // let the window settle first
	for {
		if tag, err := checkUpdate(selfExe()); err == nil && tag != "" {
			ready(tag)
			return
		}
		time.Sleep(12 * time.Hour)
	}
}

// restart starts the updated copy, which waits for this one to close before opening.
func restart() error {
	return exec.Command(selfExe(), "--after", strconv.Itoa(os.Getpid())).Start()
}

// waitForExit is the new copy's side of a restart: hold off until the old window is gone,
// so the one-copy-at-a-time check does not just bring the old window forward.
func waitForExit(args []string) {
	for i, a := range args {
		if a == "--after" && i+1 < len(args) {
			pid, err := strconv.Atoi(args[i+1])
			if err != nil {
				return
			}
			if h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid)); err == nil {
				windows.WaitForSingleObject(h, 15000)
				windows.CloseHandle(h)
			}
		}
	}
}
