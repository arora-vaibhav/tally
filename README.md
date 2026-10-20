# Tally

A small calculator notepad for Windows. Write a calculation on each line, add a note after it in plain words, and the answer appears on the right. Keep as many sheets as you like in tabs, and print any of them.

Inspired by [Numi](https://numi.app), with the things I missed on Windows: tabs that are saved, printing, and sheets stored as plain text files you own.

![Tally](docs/screenshot.png)

## Download

Get the latest build from the [Releases](../../releases) page:

| Your PC | File |
|---|---|
| Intel or AMD (most Windows PCs) | `Tally-x64.exe` |
| ARM, such as Snapdragon laptops | `Tally-arm64.exe` |

There is nothing to install. Put the file anywhere and run it. Windows 10 and 11 already include the Edge WebView2 runtime it uses.

The builds are not code-signed, so the first time you run one Windows SmartScreen may show "Windows protected your PC". Click "More info", then "Run anyway".

## What you can type

| Line | What it does |
|---|---|
| `28 x 1,950 x 12   gross rent` | words after the maths are a note |
| `rent = 1,850` | names a result so later lines can use `rent` |
| `prev` | the previous answer (or press Tab to insert it) |
| `total` | adds up the answers above, back to the last blank line or heading |
| `20% of 4,500` | percentages; also `4,500 + 15%`, `15% off 200`, `15% on 200`, `30 as % of 120` |
| `5k`, `2.5M` | thousands and millions |
| `5 km to miles` | units: length, area, volume, weight, time, temperature and more |
| `100 USD to CAD` | currencies; also `€50 in CAD` and `2,500 CAD + 300 USD` |
| `# Heading` | a section title, which also starts a new `total` |
| `// comment` | ignored |

Commas in numbers are fine. `$` on its own is treated as a plain number, since it can mean more than one currency; write the code (`USD`, `CAD`) when it matters. Click any answer to copy it.

If a line uses a name you have not defined yet, such as `occ * prev` before `occ = 95%`, the name is underlined and the answer column shows `? occ` instead of staying blank. A word straight after a number (`15% tip`) is still just a note.

## Sheets and tabs

- New sheets are named by date, `2026-10-14`, then `2026-10-14 (2)` for a second one that day. Double-click a tab to rename it; hover to see when it was created.
- Drag a tab to move it, or press Ctrl+Shift+PgUp / PgDn to move the open one. Tabs reopen in the order you left them.
- Each sheet is a `.txt` file in `Documents\Tally`, so you can back them up, sync the folder, or open them in any editor. Set `TALLY_DIR` to keep them somewhere else.
- Tally shows one folder of sheets at a time. Click the folder button to switch between recent folders, or choose another one (Ctrl+O), such as a folder per deal or per month. The picker can also make a new folder. Tally reopens on the folder you used last.
- Closing a tab moves its file to a `Trash` folder inside the sheets folder. Nothing is deleted.
- Print / PDF prints the current sheet as a clean two-column page.
- A long line scrolls sideways under the answers, which always stay at the right edge of the window.
- The window reopens where you left it, at the same size, unless that spot was on a monitor that is no longer connected; then it opens centred. Launching Tally while it is already open brings the open window forward instead of starting a second copy.

| Shortcut | Action |
|---|---|
| Ctrl+T | new sheet |
| Ctrl+W | close sheet |
| Ctrl+Tab, Ctrl+1..9 | switch sheets |
| Ctrl+Shift+PgUp / PgDn | move the open sheet left or right |
| Ctrl+P | print or save as PDF |
| Ctrl+O | choose the sheets folder |

## Currency rates

Rates are the European Central Bank reference rates (about 30 currencies) from [frankfurter.dev](https://frankfurter.dev). Tally fetches them in the background at most every 12 hours and keeps the last set in `%LOCALAPPDATA%\Tally\rates.json`, so conversions still work offline. The status line shows the date of the rates in use. They are reference rates, published once each working day, not the rate your bank will give you.

That rate request is the only thing Tally sends over the network. Your sheets never leave your PC.

## Build from source

Needs Go 1.27 or later and Node.js (for the engine tests).

```
node test_engine.js
go test ./...
go build -ldflags "-H windowsgui -s -w" -o Tally.exe .
```

Set `GOARCH=amd64` or `GOARCH=arm64` to build for the other architecture. The icon is drawn by `go run ./tools/mkicon` and embedded with `go run github.com/akavel/rsrc@v0.10.2 -ico tally.ico -arch <arch> -o rsrc_windows_<arch>.syso`; the generated `.syso` files are committed, so you only need this when changing the icon.

How it fits together:

- `main.go` opens a native window with WebView2, serves the page from the embedded `web/` folder, and reads and writes the sheet files.
- `folder.go` keeps the folder in use and the recent list, and opens the Windows folder picker.
- `web/engine.js` turns a sheet into one answer per line, on top of [math.js](https://mathjs.org).
- `web/app.js` and `web/index.html` are the editor, tabs, copying and printing.

## Licence

MIT, see [LICENSE](LICENSE). math.js is bundled under the Apache License 2.0; see [NOTICE](NOTICE).
