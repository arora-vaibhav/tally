package io.github.aroravaibhav.tally

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

// Tally on Android: one WebView showing the same web/ page as the Windows app, with the
// window.tally* functions main.go binds answered here instead (same names, same JSON shapes).
// The page is served from the APK's assets on the app's own https origin, and only that
// origin gets the bridge.
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val main = Handler(Looper.getMainLooper())
    // one Sheets per process, like disk: a recreated window must not get a second writer
    private val sheets: Sheets
        get() = shared ?: synchronized(Companion) {
            shared ?: Sheets(File(getExternalFilesDir(null) ?: filesDir, "Sheets"), File(filesDir, "settings.json")).also { shared = it }
        }
    private val ratesFile by lazy { File(filesDir, "rates.json") }
    private var pageReady = false
    private var pendingShare: String? = null
    private var pendingOpen: String? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            AlertDialog.Builder(this).setMessage("Tally needs a newer Android System WebView. Update it from the Play Store, then open Tally again.")
                .setPositiveButton("OK") { _, _ -> finish() }.setOnCancelListener { finish() }.show()
            return
        }
        current = WeakReference(this)

        // edge to edge (Android 15 insists), with the page kept clear of the bars and the keyboard
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION") run { window.statusBarColor = Color.TRANSPARENT; window.navigationBarColor = Color.TRANSPARENT }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val frame = FrameLayout(this).apply { setBackgroundColor(if (night) 0xFF151515.toInt() else 0xFFF7F7F5.toInt()) }
        WindowCompat.getInsetsController(window, frame).apply { isAppearanceLightStatusBars = !night; isAppearanceLightNavigationBars = !night }
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this)
        web.setBackgroundColor(Color.TRANSPARENT)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // the page keeps its prediction settings in localStorage
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100 // the highlight layer and the textarea must stay the same size to line up
        }
        web.webChromeClient = WebChromeClient() // gives the page its confirm() dialogs
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest) = assets.shouldInterceptRequest(req.url)

            // the page never navigates away; any other link opens in the browser
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == HOST) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, req.url)) }
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { pageReady = false }

            // app.js has run by now, so window.tallyReadLink and tallyFileOpened exist; deliver()
            // still waits for the page's first load of the sheets to finish (__tallyStarted).
            override fun onPageFinished(view: WebView, url: String) {
                if (!url.startsWith("$ORIGIN/")) return
                pageReady = true
                deliver()
            }
        }
        web.addJavascriptInterface(Bridge(), "TallyHost")
        WebViewCompat.addDocumentStartJavaScript(web, SHIM, setOf(ORIGIN))
        frame.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(frame)
        web.loadUrl("$ORIGIN/assets/web/index.html")

        // exchange rates: the page reads the cache, and is told when a fresher copy lands
        net.execute { if (Net.refreshRates(ratesFile)) main.post { js("window.tallyRatesUpdated && window.tallyRatesUpdated()") } }
        watchForUpdates(applicationContext.cacheDir)
        if (state == null) handle(intent) // a recreated window has already handled its intent
        warnOnce()
    }

    // Sheets live in Tally's own app folder, which Android empties on uninstall unless the user
    // keeps the app data (hasFragileUserData offers that), so say so once, before anything is typed.
    private fun warnOnce() {
        val prefs = getSharedPreferences("tally", MODE_PRIVATE)
        if (prefs.getBoolean("warned", false)) return
        AlertDialog.Builder(this).setTitle("Where your sheets live")
            .setMessage("Tally keeps your sheets on this phone, in its own folder. Uninstalling Tally deletes them unless you choose to keep the app's data when Android asks. Copy any sheet you need elsewhere before you uninstall.")
            .setPositiveButton("OK", null).show()
        prefs.edit().putBoolean("warned", true).apply()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    // The page saves 250 ms after the last keystroke; leaving the app saves at once, through the
    // page's own beforeunload handler, so nothing typed is lost when Android closes Tally.
    override fun onPause() {
        super.onPause()
        if (::web.isInitialized && pageReady) js("window.dispatchEvent(new Event('beforeunload'))")
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    // ---- share and open ------------------------------------------------------

    private fun handle(i: Intent?) {
        when (i?.action) {
            Intent.ACTION_SEND -> i.getStringExtra(Intent.EXTRA_TEXT)?.let { pendingShare = it; deliver() }
            Intent.ACTION_VIEW -> i.data?.let { importFile(it) }
        }
    }

    // A .note or .txt opened from another app is copied into the sheets folder in use (the
    // original stays where it was) and shown on its own tab.
    private fun importFile(uri: Uri) = disk.execute {
        try {
            val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: uri.lastPathSegment ?: ""
            if (!isSheetFile(name)) throw Exception("Tally opens .note and .txt files")
            // read at most 5 MB, so a huge file sent by another app cannot run Tally out of memory
            val bytes = contentResolver.openInputStream(uri)?.let { input ->
                try { Net.read(input, 5 shl 20, Long.MAX_VALUE) } catch (e: Exception) { throw if (e.message == Net.TOO_LARGE) Exception("$name is too large for a sheet") else e }
            } ?: throw Exception("cannot read $name")
            val f = sheets.import(name, bytes)
            main.post { pendingOpen = f.path; deliver() }
        } catch (e: Exception) {
            main.post { Toast.makeText(this, e.message ?: "Could not open the file", Toast.LENGTH_LONG).show() }
        }
    }

    // Both replace or add to the page's sheets, so they wait until its first show() is done,
    // or the new deal sheet or tab could be overwritten by the initial load.
    private fun deliver() {
        if (!pageReady) return
        pendingShare?.let { js("window.__tallyStarted.then(function () { window.tallyReadLink && window.tallyReadLink(${JSONObject.quote(it)}); })") }
        pendingOpen?.let { js("window.__tallyStarted.then(function () { window.tallyFileOpened && window.tallyFileOpened(${JSONObject.quote(it)}); })") }
        pendingShare = null
        pendingOpen = null
        Updater.staged.takeIf { it != "" }?.let { js("window.tallyUpdateReady && window.tallyUpdateReady(${JSONObject.quote(it)})") }
    }

    private fun js(code: String) = web.evaluateJavascript(code, null)

    // ---- the bridge ----------------------------------------------------------

    inner class Bridge {
        // Called on a WebView thread. Only the app's own page is answered: the URL is checked on
        // the main thread, where the WebView may be asked for it.
        @JavascriptInterface
        fun call(id: Int, name: String, args: String) {
            main.post { if (web.url?.startsWith("$ORIGIN/") == true) dispatch(id, name, args) }
        }
    }

    private fun dispatch(id: Int, name: String, json: String) {
        val a = try { JSONArray(json) } catch (e: Exception) { JSONArray() }
        when (name) {
            "tallyFetch" -> net.execute { answer(id) { Net.fetch(a.getString(0), a.optJSONObject(1)) } }
            "tallyRates" -> net.execute { answer(id) { Net.cachedRates(ratesFile) } }
            "tallyChooseFolder" -> chooseFolder(id)
            "tallyRestart" -> answer(id) { install() }
            "print" -> answer(id) {
                (getSystemService(PRINT_SERVICE) as PrintManager).print("Tally", web.createPrintDocumentAdapter("Tally"), null)
                null
            }
            "tallyOpenFolder" -> disk.execute {
                val d = sheets.dir.path
                main.post { Toast.makeText(this, "Sheets are in $d", Toast.LENGTH_LONG).show() }
                answer(id) { null }
            }
            else -> disk.execute { answer(id) { sheetCall(name, a) } }
        }
    }

    private fun sheetCall(name: String, a: JSONArray): Any? = when (name) {
        "tallyLoad" -> sheets.load()
        "tallySave" -> sheets.save(a.getString(0), a.getString(1))
        "tallyCreate" -> sheets.create(a.getString(0))
        "tallyRename" -> sheets.rename(a.getString(0), a.getString(1))
        "tallyTrash" -> sheets.trash(a.getString(0))
        "tallyOrder" -> sheets.order(a.optJSONArray(0) ?: JSONArray(), a.optString(1))
        "tallyUseFolder" -> sheets.useFolder(a.getString(0))
        "tallyOpenPath" -> sheets.openPath(a.getString(0))
        "tallyVersion" -> BuildConfig.VERSION_NAME
        else -> throw Exception("Tally has no $name")
    }

    // Runs block and settles the page's promise with its value, or rejects it with the error
    // text, as go-webview2 does for the Windows bindings.
    private fun answer(id: Int, block: () -> Any?) {
        val (ok, v) = try { true to block() } catch (e: Throwable) { false to (e.message ?: e.toString()) }
        val out = when (v) {
            null, Unit -> "null"
            is String -> JSONObject.quote(v)
            else -> v.toString() // JSONObject, JSONArray
        }
        main.post { if (::web.isInitialized) js("window.__tallyDone($id,$ok,$out)") }
    }

    // ---- choosing a folder ---------------------------------------------------

    // chooseFolder in folder.go: the folders under Tally's Sheets folder, or a new one. Settles
    // with null when the user backs out, as the Windows picker does when cancelled.
    private fun chooseFolder(id: Int) = disk.execute {
        val folders = sheets.folders()
        main.post {
            val done = AtomicBoolean(false)
            val finish = { block: () -> Any? -> if (done.compareAndSet(false, true)) disk.execute { answer(id, block) } }
            AlertDialog.Builder(this).setTitle("Choose a sheets folder")
                .setItems((folders.map { it.name } + "New folder...").toTypedArray()) { _, i ->
                    if (i < folders.size) finish { sheets.useFolder(folders[i].path) } else {
                        val input = EditText(this).apply { hint = "Folder name"; isSingleLine = true }
                        AlertDialog.Builder(this).setTitle("New sheets folder").setView(input)
                            .setPositiveButton("Create") { _, _ -> finish { sheets.useFolder(sheets.newFolder(input.text.toString()).path) } }
                            .setNegativeButton("Cancel") { _, _ -> finish { null } }
                            .setOnCancelListener { finish { null } }
                            .show()
                    }
                }
                .setOnCancelListener { finish { null } }
                .show()
        }
    }

    // ---- updates -------------------------------------------------------------

    // restart in update.go: here it hands the verified APK to the system installer, which asks
    // the user and replaces Tally (the sheets stay where they are).
    private fun install() {
        val f = Updater.apk(cacheDir)
        if (Updater.staged == "" || !f.exists()) throw Exception("no update has been downloaded")
        if (!packageManager.canRequestPackageInstalls()) {
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            throw Exception("allow Tally to install updates, then tap it again")
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        private const val NAMES = "tallyLoad tallySave tallyCreate tallyRename tallyTrash tallyOrder tallyOpenFolder " +
            "tallyChooseFolder tallyUseFolder tallyOpenPath tallyVersion tallyRestart tallyRates tallyFetch"

        private val disk = Executors.newSingleThreadExecutor() // one at a time per process, as mu does in main.go
        private val net = Executors.newCachedThreadPool() // a slow site never holds up a save
        @Volatile private var shared: Sheets? = null

        // Defines every window.tally* before app.js runs (it checks for tallyLoad at load), each
        // a promise settled by window.__tallyDone. window.print goes to Android's print dialog,
        // which a WebView does not open by itself.
        // __tallyStarted settles once the first tallyLoad has answered and no call is left
        // waiting: app.js's start() then has nothing more to await, so its show() is done
        // (an empty folder first creates and saves a sheet, which keeps a call waiting).
        // shortcut: inferred from the bridge, not told by app.js; a window.tallyReady set by app.js would be exact.
        private val SHIM = """
            (function () {
              if (window.__tallyDone) return;
              var next = 0, waiting = {}, loaded = false, started;
              window.__tallyStarted = new Promise(function (r) { started = r; });
              function idle() { for (var k in waiting) return false; return true; }
              window.__tallyDone = function (id, ok, v) {
                var p = waiting[id]; delete waiting[id]; if (p) p[ok ? 0 : 1](v);
                if (p && p[2] === "tallyLoad") loaded = true;
                if (loaded) setTimeout(function () { if (idle()) started(); }, 0);
              };
              function call(name) {
                return function () {
                  var args = Array.prototype.slice.call(arguments);
                  return new Promise(function (res, rej) { var id = ++next; waiting[id] = [res, rej, name]; TallyHost.call(id, name, JSON.stringify(args)); });
                };
              }
              "$NAMES".split(" ").forEach(function (n) { window[n] = call(n); });
              window.print = function () { call("print")(); };
            })();
        """.trimIndent()

        @Volatile private var current: WeakReference<MainActivity>? = null
        private val watching = AtomicBoolean(false)

        // watchForUpdates in update.go: now and every 12 hours, once per app run; the window open
        // at the time is told, and a later one is told when its page loads (deliver).
        private fun watchForUpdates(cache: File) {
            if (!watching.compareAndSet(false, true)) return
            thread(isDaemon = true) {
                Thread.sleep(5_000) // let the window settle first
                while (true) {
                    if (runCatching { Updater.check(BuildConfig.VERSION_NAME, cache) }.getOrDefault("") != "") {
                        current?.get()?.let { a -> a.main.post { a.deliver() } }
                        return@thread
                    }
                    Thread.sleep(12 * 3600_000L)
                }
            }
        }
    }
}
