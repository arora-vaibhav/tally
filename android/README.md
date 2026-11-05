# Tally for Android

The Android app is a thin native shell around the same page as the Windows app. Everything
you see and type (the engine, predictions, deal sheets, listing links) is the code in
`../web`, copied into the APK when it is built. The Kotlin here only does what a page cannot:

- **Sheets** are plain `.note` and `.txt` files, one folder of them at a time, under
  `Android/data/io.github.aroravaibhav.tally/files/Sheets/` (the first folder is `Tally`).
  `_tabs.json` keeps the tab order and creation dates, exactly as on Windows, so a folder
  copied between a PC and a phone reads the same. Closing a tab moves its file to `Trash`
  inside the folder; nothing is deleted. The folder button lists the folders there and can
  make a new one.
  **Uninstalling Tally deletes this folder** unless you choose to keep the app's data when
  Android asks (Tally sets `hasFragileUserData` so it does ask). Tally says so once on first
  run. Copy any sheet you need elsewhere before uninstalling, and never move from a
  debug-signed APK to a release one (that also needs an uninstall).
- **Listing links**: share a listing to Tally from Centris, Chrome or any app (Share > Tally),
  or paste a link. The app fetches the page itself (`tallyFetch`, the same request as
  `fetch.go`) and the site readers in `web/sites/` turn it into a deal sheet. Android does
  not allow plain `http`, so an `http://` link or redirect is fetched over `https` instead.
- **Opening a file**: a `.note` or `.txt` opened from Files, Drive or an email is copied into
  the sheets folder in use and shown on its own tab. The original stays where it was.
- **Exchange rates** come from the same ECB feed as on Windows, cached for 12 hours.
- **Updates**: a release build checks GitHub at start and every 12 hours, downloads
  `Tally-android.apk` when there is a newer release, and keeps it only if its SHA-256
  matches the one in the release. The page then offers the update; tapping it opens
  Android's installer (the first time, Android asks to allow Tally to install apps).
- **Print** opens Android's print dialog, which can also save a PDF.

How the page talks to the app: before `app.js` runs, a small script defines every
`window.tally*` function the Windows app binds, each one a promise answered by
`MainActivity`. Only the app's own page (`https://appassets.androidplatform.net/`) gets them.

## Building

You need JDK 17, the Android SDK (platform `android-35`, build-tools `35.0.0`) and Gradle 8.x.
No Gradle wrapper is checked in; use a Gradle install.

```
cd android
gradle assembleDebug              # app/build/outputs/apk/debug/app-debug.apk
gradle testDebugUnitTest          # name cleaning, checksums, versions
gradle assembleRelease -PtallyVersion=v1.7.0
```

Set `ANDROID_HOME` to the SDK, or put `sdk.dir=...` in `android/local.properties`.

The version comes from `-PtallyVersion` (the release tag). Without it the build is `dev`,
which never updates itself. The version code is derived from it: `v1.7.0` is `10700`.

A release build is signed with the key named by these environment variables, and with the
debug key when they are not set:

| Variable | What |
|---|---|
| `TALLY_KEYSTORE` | path to the `.jks` |
| `TALLY_KEYSTORE_PASSWORD` | keystore password |
| `TALLY_KEY_ALIAS` | key alias (`tally`) |
| `TALLY_KEY_PASSWORD` | key password |

The release keystore is kept with the other credentials, in
`C:\Projects\Google Credentials\Tally\` (`tally-release.jks`, passwords in
`tally-release.txt`). Keep it safe: phones only accept an update signed with the same key,
so losing it means everyone has to uninstall and reinstall.

## Releases

Pushing a `v*` tag builds everything in CI (`.github/workflows/ci.yml`). The `android` job
runs the unit tests and builds the APK with the tag as its version, and the Windows `build`
job runs on its own, so an Android failure never stops the Windows tests or build. The
`release` job waits for both, then publishes `Tally-android.apk` in the same GitHub release as
the `.exe` files, with its SHA-256 in the same checksum block the apps check their downloads
against. The tag must be `vX.Y.Z` (or `vX.Y`): the version code is made from it, and a tag
such as `v1.8.0-rc1` is refused rather than shipped with version code 1.

CI needs these repository secrets for the release key (Settings > Secrets and variables >
Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | the `.jks`, base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("tally-release.jks"))` |
| `ANDROID_KEYSTORE_PASSWORD` | `TALLY_KEYSTORE_PASSWORD` from `tally-release.txt` |
| `ANDROID_KEY_ALIAS` | `tally` |
| `ANDROID_KEY_PASSWORD` | `TALLY_KEY_PASSWORD` from `tally-release.txt` |

Without them, branch and pull request builds still work (debug-signed), but a tag build
stops rather than publish an APK that installed copies could not update to, and so no
release is published for that tag (the Windows build still runs). Set them before the next tag.

## Installing on a phone

Download `Tally-android.apk` from the latest release on the phone and open it. Android asks
once to allow installing from that app (the browser, or Files). After that, Tally keeps
itself up to date.
