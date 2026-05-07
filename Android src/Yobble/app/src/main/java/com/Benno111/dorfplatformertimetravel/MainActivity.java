package com.Benno111.dorfplatformertimetravel;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.Manifest;
import android.os.Build;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.webkit.ConsoleMessage;
import android.webkit.MimeTypeMap;
import android.view.View;
import android.view.KeyEvent;
import android.util.Base64;
import android.util.Log;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.os.Looper;
import android.view.ViewGroup;

import androidx.core.app.ActivityCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONTokener;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.Iterator;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private static final String TAG = "MainActivity";
    private static final String BASE_URL = "http://photography-cage.gl.at.ply.gg:52426";
    private static final int REQUEST_FILE_CHOOSER = 1002;
    private static final int REQUEST_READ_STORAGE  = 1003;

    private WebView webView;
    private ViewGroup webViewContainer;
    private StorageExporter storageExporter;
    private String initialLocalStorageSnapshot;
    private boolean hasRestoredLocalStorage = false;
    private WebViewAssetLoader assetLoader;
    private String currentTargetUrl;

    /** Holds the callback provided by WebView when a file-input is tapped. */
    private ValueCallback<Uri[]> fileChooserCallback;

    private final WebViewClient externalTabClient = new WebViewClient() {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            boolean handled = openUrlExternally(request.getUrl());
            view.destroy();
            return handled;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            boolean handled = openUrlExternally(Uri.parse(url));
            view.destroy();
            return handled;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Prevent accidental WebView calls off the UI thread
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new RuntimeException("WebView must run on the MAIN/UI thread!");
        }

        // Lock device orientation
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);

        // Fullscreen mode
        hideSystemUI();

        setContentView(R.layout.main);
        webViewContainer = findViewById(R.id.webview_container);

        storageExporter = new StorageExporter(this);
        initialLocalStorageSnapshot = storageExporter.readLocalStorageSnapshot();
        ensureLegacyStoragePermission();
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        // Initialize WebView only on main thread
        webView = GameWebViewHolder.get(this).acquire(this);
        attachWebView();
        configureWebViewSettings();
        webView.clearCache(true);
        webView.clearHistory();
        webView.clearFormData();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request != null && !"GET".equalsIgnoreCase(request.getMethod())) {
                    return super.shouldInterceptRequest(view, request);
                }
                Uri uri = request.getUrl();
                WebResourceResponse asset = assetLoader.shouldInterceptRequest(uri);
                if (asset != null) return asset;
                WebResourceResponse offlineGame = interceptOfflineGameRequest(uri);
                if (offlineGame != null) return offlineGame;
                WebResourceResponse assetFile = interceptAssetRequest(uri);
                if (assetFile != null) return assetFile;
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                Uri uri = Uri.parse(url);
                WebResourceResponse asset = assetLoader.shouldInterceptRequest(uri);
                if (asset != null) return asset;
                WebResourceResponse offlineGame = interceptOfflineGameRequest(uri);
                if (offlineGame != null) return offlineGame;
                WebResourceResponse assetFile = interceptAssetRequest(uri);
                if (assetFile != null) return assetFile;
                return super.shouldInterceptRequest(view, url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (is404PageUrl(url)) {
                    return;
                }
                if (!hasRestoredLocalStorage && initialLocalStorageSnapshot != null && !initialLocalStorageSnapshot.isEmpty()) {
                    hasRestoredLocalStorage = true;
                    restoreLocalStorageSnapshot(initialLocalStorageSnapshot);
                    initialLocalStorageSnapshot = null;
                    return;
                }
                exportLocalStorageSnapshot();
                warmOfflineCopyIfNeeded(url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request == null || !request.isForMainFrame()) {
                    return;
                }
                String target = request.getUrl() != null ? request.getUrl().toString() : currentTargetUrl;
                if (tryLoadOfflineFallback(target)) {
                    return;
                }
                showErrorPage("Yobble could not load",
                        error != null ? String.valueOf(error.getDescription()) : "The app could not reach the server.",
                        target);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request == null || !request.isForMainFrame()) {
                    return;
                }
                String target = request.getUrl() != null ? request.getUrl().toString() : currentTargetUrl;
                if (tryLoadOfflineFallback(target)) {
                    return;
                }
                String message = "HTTP " + (errorResponse != null ? errorResponse.getStatusCode() : "error");
                showErrorPage("Yobble could not load", message, target);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView newWebView = new WebView(MainActivity.this);
                newWebView.setWebViewClient(externalTabClient);

                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(newWebView);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                // Cancel any previous callback that was never resolved
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = callback;

                // On Android < 13 we may need READ_EXTERNAL_STORAGE before showing the picker
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                        && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        && ActivityCompat.checkSelfPermission(MainActivity.this,
                                Manifest.permission.READ_EXTERNAL_STORAGE)
                                != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[]{Manifest.permission.READ_EXTERNAL_STORAGE},
                            REQUEST_READ_STORAGE);
                    return true;
                }

                launchFilePicker(params);
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(TAG, "JS Console: [" + consoleMessage.messageLevel() + "] "
                        + consoleMessage.message() + " ("
                        + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + ")");
                return super.onConsoleMessage(consoleMessage);
            }
        });

        // ✅ Load game HTML
        loadAppUrl(BASE_URL + "/");

        // Enable Chrome remote debugging to inspect console/network in dev tools
        WebView.setWebContentsDebuggingEnabled(true);
    }

    // ✅ When app loses focus → pause JS, media, timers, background work
    @Override
    protected void onPause() {
        super.onPause();
        try {
            webView.onPause();      // pause audio/video
            webView.pauseTimers();  // pause JavaScript timers & workers
        } catch (Exception e) {}

        // ✅ Stop any threads you manually created here
        // Example:
        // if (myThread != null && myThread.isAlive()) myThread.interrupt();
        // if (executorService != null) executorService.shutdownNow();
    }

    // ✅ Resume WebView & JS only when activity is visible
    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
        hideSystemUI();
        ensureWebViewFocus();
    }

    @Override
    protected void onDestroy() {
        if (webViewContainer != null && webView != null && webView.getParent() == webViewContainer) {
            webViewContainer.removeView(webView);
        }
        GameWebViewHolder.get(this).releaseToAppContext();
        super.onDestroy();
    }

    private void hideSystemUI() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
        );
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUI();
            ensureWebViewFocus();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_P));
            webView.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_P));
        }
    }

    private boolean openUrlExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void loadAppUrl(String url) {
        currentTargetUrl = url;
        if (webView == null) return;
        webView.loadUrl(url);
        warmOfflineCopyIfNeeded(url);
    }

    private boolean tryLoadOfflineFallback(String targetUrl) {
        if (targetUrl == null || targetUrl.isEmpty()) {
            return false;
        }
        String offlinePath = resolveOfflineEntryPath(targetUrl);
        if (offlinePath == null) {
            return false;
        }
        webView.post(() -> webView.loadUrl(Uri.fromFile(new File(offlinePath)).toString()));
        return true;
    }

    private String escapeHtml(String value) {
        return String.valueOf(value)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private String escapeJs(String value) {
        return String.valueOf(value)
                .replace("\\", "\\\\")
                .replace("'", "\\'");
    }

    private void showErrorPage(String title, String message, String retryUrl) {
        if (webView == null) return;
        String safeTitle = escapeHtml(title != null ? title : "Unable to load app");
        String safeMessage = escapeHtml(message != null ? message : "Please check your connection and try again.");
        String safeRetry = escapeJs(retryUrl != null ? retryUrl : BASE_URL + "/");
        String safeHome = escapeHtml(BASE_URL + "/index");
        String html = "<!doctype html><html><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>" + safeTitle + "</title>"
                + "<style>"
                + "html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e5e7eb}"
                + "main{min-height:100vh;display:grid;place-items:center;padding:24px}"
                + ".card{max-width:720px;width:100%;background:rgba(15,23,42,.92);border:1px solid rgba(148,163,184,.2);border-radius:20px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)}"
                + "h1{margin:0 0 10px;font-size:28px}p{margin:0 0 16px;line-height:1.5;color:#cbd5e1}"
                + ".actions{display:flex;gap:10px;flex-wrap:wrap}button,a{border:1px solid rgba(148,163,184,.24);background:#0f172a;color:#f8fafc;border-radius:12px;padding:10px 14px;font:inherit;cursor:pointer;text-decoration:none}"
                + ".primary{background:#2563eb;border-color:#2563eb}"
                + "</style></head><body><main><section class=\"card\"><h1>" + safeTitle + "</h1><p>" + safeMessage + "</p>"
                + "<div class=\"actions\"><button class=\"primary\" onclick=\"location.href='" + safeRetry + "'\">Retry</button>"
                + "<a href='" + safeHome + "'>Home</a></div></section></main></body></html>";
        webView.loadDataWithBaseURL(BASE_URL, html, "text/html", "UTF-8", null);
    }

    private void warmOfflineCopyIfNeeded(String targetUrl) {
        Uri uri = Uri.parse(targetUrl);
        String project = uri.getQueryParameter("project");
        String version = uri.getQueryParameter("version");
        if (project == null || version == null) {
            return;
        }
        String entry = uri.getQueryParameter("entry");
        if (resolveOfflineEntryPath(project, version, entry) != null) {
            return;
        }
        new Thread(() -> {
            try {
                downloadOfflineGame(project, version);
            } catch (Exception e) {
                Log.d(TAG, "Offline cache warm-up failed: " + e.getMessage());
            }
        }).start();
    }

    private File getOfflineRoot() {
        File root = new File(getFilesDir(), "offline-games");
        if (!root.exists()) {
            root.mkdirs();
        }
        return root;
    }

    private String safeSegment(String value) {
        if (value == null) return "unknown";
        String cleaned = value.trim().replaceAll("[^a-zA-Z0-9._-]+", "_");
        return cleaned.isEmpty() ? "unknown" : cleaned;
    }

    private File getOfflineVersionDir(String project, String version) {
        return new File(new File(getOfflineRoot(), safeSegment(project)), safeSegment(version));
    }

    private File getOfflineMarkerFile(String project, String version) {
        return new File(getOfflineVersionDir(project, version), ".complete");
    }

    private String normalizeEntry(String entry) {
        if (entry == null || entry.trim().isEmpty()) {
            return "index";
        }
        return entry.trim().replaceFirst("^/+", "");
    }

    private String resolveOfflineEntryPath(String project, String version, String entry) {
        File versionDir = getOfflineVersionDir(project, version);
        File marker = getOfflineMarkerFile(project, version);
        if (!marker.exists()) {
            return null;
        }
        String normalized = normalizeEntry(entry);
        String[] candidates = new String[] {
                normalized,
                normalized.endsWith(".html") ? normalized : normalized + ".html",
                normalized + "/index.html"
        };
        for (String candidate : candidates) {
            File file = new File(versionDir, candidate);
            try {
                String resolved = file.getCanonicalPath();
                String root = versionDir.getCanonicalPath();
                if (!resolved.startsWith(root)) {
                    continue;
                }
                if (file.exists() && file.isFile()) {
                    return file.getAbsolutePath();
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private String resolveOfflineEntryPath(String targetUrl) {
        try {
            Uri uri = Uri.parse(targetUrl);
            String project = uri.getQueryParameter("project");
            String version = uri.getQueryParameter("version");
            String entry = uri.getQueryParameter("entry");
            if (project == null || version == null) return null;
            return resolveOfflineEntryPath(project, version, entry);
        } catch (Exception e) {
            return null;
        }
    }

    private void downloadOfflineGame(String project, String version) throws Exception {
        File versionDir = getOfflineVersionDir(project, version);
        if (!versionDir.exists() && !versionDir.mkdirs()) {
            throw new IllegalStateException("Unable to create offline cache directory");
        }
        String manifestUrl = BASE_URL + "/games/"
                + Uri.encode(project) + "/" + Uri.encode(version) + "/assets.json";
        JSONObject manifest = fetchJson(manifestUrl);
        JSONObject versionFiles = manifest.optJSONObject(version);
        if (versionFiles == null) {
            return;
        }
        Iterator<String> keys = versionFiles.keys();
        while (keys.hasNext()) {
            String relPath = keys.next();
            File target = new File(versionDir, relPath);
            String resolvedTarget = target.getCanonicalPath();
            String root = versionDir.getCanonicalPath();
            if (!resolvedTarget.startsWith(root)) {
                continue;
            }
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            StringBuilder fileUrl = new StringBuilder(BASE_URL)
                    .append("/games/")
                    .append(Uri.encode(project))
                    .append("/")
                    .append(Uri.encode(version))
                    .append("/");
            String[] parts = relPath.split("/");
            boolean first = true;
            for (String part : parts) {
                if (part == null || part.isEmpty()) continue;
                if (!first) {
                    fileUrl.append("/");
                }
                fileUrl.append(Uri.encode(part));
                first = false;
            }
            downloadFile(fileUrl.toString(), target);
        }
        File marker = getOfflineMarkerFile(project, version);
        File markerParent = marker.getParentFile();
        if (markerParent != null && !markerParent.exists()) {
            markerParent.mkdirs();
        }
        try (FileOutputStream out = new FileOutputStream(marker, false)) {
            out.write(String.valueOf(System.currentTimeMillis()).getBytes());
            out.flush();
        }
    }

    private JSONObject fetchJson(String urlString) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setUseCaches(false);
            connection.connect();
            int code = connection.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
            if (stream == null) {
                throw new IllegalStateException("Empty response");
            }
            try (BufferedInputStream in = new BufferedInputStream(stream);
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("HTTP " + code + ": " + out.toString());
                }
                return new JSONObject(out.toString());
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void downloadFile(String urlString, File target) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setUseCaches(false);
            connection.connect();
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IllegalStateException("HTTP " + code);
            }
            try (InputStream stream = connection.getInputStream();
                 BufferedInputStream in = new BufferedInputStream(stream);
                 BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(target, false))) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                out.flush();
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void ensureWebViewFocus() {
        if (webView != null) {
            webView.requestFocus();
            webView.requestFocusFromTouch();
        }
    }

    private void attachWebView() {
        if (webViewContainer == null || webView == null) return;
        if (webView.getParent() != null && webView.getParent() != webViewContainer) {
            ((ViewGroup) webView.getParent()).removeView(webView);
        }
        if (webView.getParent() == null) {
            webViewContainer.addView(webView,
                    new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
        }
    }

    private boolean is404PageUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            Uri uri = Uri.parse(url);
            String path = uri.getPath();
            if (path == null || path.isEmpty()) return false;
            return path.equals("/404")
                    || path.equals("/404.html")
                    || path.endsWith("/404")
                    || path.endsWith("/404.html");
        } catch (Exception e) {
            return false;
        }
    }

    private void configureWebViewSettings() {
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setAllowFileAccessFromFileURLs(true);
        webView.getSettings().setAllowContentAccess(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.getSettings().setSupportMultipleWindows(true);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);
        webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webView.getSettings().setAllowUniversalAccessFromFileURLs(true);
        webView.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            webView.getSettings().setOffscreenPreRaster(true); // pre-render to shorten visible load time
        }
    }

    private void restoreLocalStorageSnapshot(String snapshot) {
        if (webView == null) return;
        if (snapshot == null || snapshot.isEmpty()) return;
        String base64 = Base64.encodeToString(snapshot.getBytes(), Base64.NO_WRAP);
        final String script = "(function(){try{var json=decodeURIComponent(escape(atob('" + base64 + "')));"
                + "var data=JSON.parse(json);localStorage.clear();"
                + "Object.keys(data).forEach(function(k){localStorage.setItem(k,data[k]);});return 'ok';}"
                + "catch(e){return 'error';}})();";
        webView.evaluateJavascript(script, value -> webView.post(webView::reload));
    }

    private void ensureLegacyStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1001);
    }

    private String guessMimeType(Uri uri) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(uri.toString());
        if (extension == null) return null;
        extension = extension.toLowerCase(Locale.ROOT);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (mime != null) return mime;
        if (extension.equals("svg")) return "image/svg+xml";
        if (extension.equals("ogg")) return "audio/ogg";
        if (extension.equals("woff")) return "font/woff";
        if (extension.equals("woff2")) return "font/woff2";
        if (extension.equals("ttf")) return "font/ttf";
        if (extension.equals("otf")) return "font/otf";
        return null;
    }

    private WebResourceResponse interceptOfflineGameRequest(Uri uri) {
        if (uri == null) return null;
        String host = uri.getHost();
        if (host == null || !host.equalsIgnoreCase(Uri.parse(BASE_URL).getHost())) return null;
        String path = uri.getPath();
        if (path == null) return null;

        String[] parts = path.split("/");
        if (parts.length < 5) return null;
        if (!"games".equals(parts[1])) return null;

        String project = Uri.decode(parts[2]);
        String version = Uri.decode(parts[3]);
        File versionDir = getOfflineVersionDir(project, version);
        File marker = getOfflineMarkerFile(project, version);
        if (!marker.exists()) return null;

        StringBuilder rel = new StringBuilder();
        for (int i = 4; i < parts.length; i++) {
            if (parts[i] == null || parts[i].isEmpty()) continue;
            if (rel.length() > 0) rel.append('/');
            rel.append(Uri.decode(parts[i]));
        }
        if (rel.length() == 0) return null;

        try {
            File target = new File(versionDir, rel.toString());
            String resolved = target.getCanonicalPath();
            String root = versionDir.getCanonicalPath();
            if (!resolved.startsWith(root) || !target.exists() || !target.isFile()) return null;

            String mime = resolveMimeType(uri, null);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(mime, null, 200, "OK", headers, new java.io.FileInputStream(target));
        } catch (Exception ignored) {
            return null;
        }
    }

    private WebResourceResponse interceptAssetRequest(Uri uri) {
        if (uri == null) return null;
        if (!"file".equalsIgnoreCase(uri.getScheme())) return null;
        String path = uri.getPath();
        if (path == null || !path.startsWith("/android_asset/assets/")) return null;
        try {
            String assetPath = path.substring("/android_asset/".length());
            String mime = resolveMimeType(uri, null);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(mime, null, 200, "OK", headers, getAssets().open(assetPath));
        } catch (Exception e) {
            return null;
        }
    }

    private String resolveMimeType(Uri uri, String mimeFromHeader) {
        if (mimeFromHeader != null && !mimeFromHeader.isEmpty()) {
            int semicolon = mimeFromHeader.indexOf(';');
            if (semicolon > 0) {
                return mimeFromHeader.substring(0, semicolon).trim();
            }
            return mimeFromHeader.trim();
        }
        String guessed = guessMimeType(uri);
        return guessed != null ? guessed : "application/octet-stream";
    }

    private void launchFilePicker(WebChromeClient.FileChooserParams params) {
        Intent intent = (params != null) ? params.createIntent() : null;
        if (intent == null) {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
        }
        try {
            startActivityForResult(Intent.createChooser(intent, "Choose file"), REQUEST_FILE_CHOOSER);
        } catch (Exception e) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (fileChooserCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQUEST_READ_STORAGE) {
            // Permission granted or denied — either way open the picker now
            if (fileChooserCallback != null) {
                launchFilePicker(null);
            }
        } else {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        }
    }

    private void exportLocalStorageSnapshot() {
        if (webView == null) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) return; // evaluateJavascript requires 19+

        final String script =
                "(function(){try{const o={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);o[k]=localStorage.getItem(k);}const json=JSON.stringify(o);return btoa(unescape(encodeURIComponent(json)));}catch(e){return '';} })();";

        webView.evaluateJavascript(script, value -> {
            try {
                String decodedJsString = (String) new JSONTokener(value).nextValue();
                if (decodedJsString == null || decodedJsString.isEmpty()) return;
                byte[] data = android.util.Base64.decode(decodedJsString, android.util.Base64.DEFAULT);
                storageExporter.saveLocalStorageSnapshot(new String(data));
            } catch (Exception e) {
                // ignore
            }
        });
    }
}
