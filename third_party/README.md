# third_party

`go-webview2` is github.com/jchv/go-webview2 at v0.0.0-20260205173254-56598839c808 (MIT, see its LICENSE), used through a `replace` in go.mod with one fix:

The library checks COM calls by the thread's last Windows error (GetLastError) instead of the HRESULT the call returns. That value is left over from earlier calls, and WebView2 does overlapped I/O while it starts, so `GetSettings`, `PutAreDefaultContextMenusEnabled` and `PutAreDevToolsEnabled` sometimes "failed" with "Overlapped I/O operation is in progress" and `NewWithOptions` called log.Fatal: Tally closed at startup now and then. Those three now check the HRESULT. Drop the copy once upstream checks HRESULTs.
