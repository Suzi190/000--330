package com.ephone.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import android.window.OnBackInvokedDispatcher;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;

/**
 * 把静态网页（index.html/script.js/style.css）包进全屏 WebView 的宿主 Activity。
 *
 * 关键点：
 *  - 通过 WebViewAssetLoader 用 https://appassets.androidplatform.net/assets/www/ 提供本地页面，
 *    这样 localStorage / IndexedDB / 剪贴板等能力与线上环境一致；
 *  - 沉浸式全屏：隐藏状态栏 + 导航栏，软键盘弹出时按 IME inset 收缩 WebView；
 *  - 返回手势：先询问网页 window.__ephoneHandleBack()，只有网页没有可返回的界面时才退出应用。
 */
public class MainActivity extends Activity {
    private static final String TAG = "EPhone";
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int REQ_FILE_CHOOSER = 10001;

    private static final String JS_CLEAN_SERVICE_WORKER =
            "(function(){try{" +
            "if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){try{r.unregister();}catch(e){}});});}" +
            "if(window.caches&&caches.keys){caches.keys().then(function(ks){ks.forEach(function(k){try{caches.delete(k);}catch(e){}});});}" +
            "}catch(e){}})();";

    private static final String JS_ENSURE_NATIVE =
            "(function(){try{" +
            "if(window.__EPHONE_NATIVE__||!window.AndroidApp){return;}" +
            "var s=document.createElement('script');" +
            "s.src='/assets/www/native/ephone-native.js';" +
            "(document.head||document.documentElement).appendChild(s);" +
            "}catch(e){}})();";

    private static final String JS_BACK =
            "(function(){try{" +
            "var r=window.__ephoneHandleBack?window.__ephoneHandleBack():'none';" +
            "if(r===true||r==='handled'){return 'handled';}" +
            "if(r==='exit'){return 'exit';}" +
            "return 'none';" +
            "}catch(e){return 'none';}})()";

    private FrameLayout rootLayout;
    private WebView webView;
    private WebView popupWebView;
    private NativeFileBridge nativeBridge;
    private ValueCallback<Uri[]> filePathCallback;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean pageReady = false;
    private boolean imeVisible = false;
    private boolean backPending = false;
    private long lastBackAt = 0L;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        buildContentView();
        configureWebView();
        registerBackHandler();
        webView.loadUrl(APP_URL);
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        // 内容铺满整个屏幕，系统栏只作为临时浮层出现
        WindowCompat.setDecorFitsSystemWindows(window, false);

        WindowManager.LayoutParams attrs = window.getAttributes();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
        hideSystemBars();
    }

    private void buildContentView() {
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#F0F2F5"));
        webView = new WebView(this);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        rootLayout.addView(webView, params);
        setContentView(rootLayout);

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout, (view, insets) -> {
            boolean ime = insets.isVisible(WindowInsetsCompat.Type.ime());
            int bottom = ime ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            if (view.getPaddingBottom() != bottom) {
                view.setPadding(view.getPaddingLeft(), view.getPaddingTop(), view.getPaddingRight(), bottom);
            }
            if (ime != imeVisible) {
                imeVisible = ime;
                if (!ime) {
                    view.postDelayed(this::hideSystemBars, 120);
                }
            }
            return insets;
        });
    }
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        }

        webView.setBackgroundColor(Color.parseColor("#F0F2F5"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setLongClickable(true);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        nativeBridge = new NativeFileBridge(this);
        webView.addJavascriptInterface(nativeBridge, "AndroidApp");

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) { return false; }
                if (APP_HOST.equals(uri.getHost())) { return false; }

                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                if ("http".equals(scheme) || "https".equals(scheme)
                        || "mailto".equals(scheme) || "tel".equals(scheme)) {
                    openExternal(uri);
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageReady = true;
                view.evaluateJavascript(JS_CLEAN_SERVICE_WORKER, null);
                // 兜底：如果 index.html 里的 document.write 因为时序问题没插进来，这里补一次
                view.evaluateJavascript(JS_ENSURE_NATIVE, null);
                hideSystemBars();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent = null;
                try {
                    intent = params.createIntent();
                } catch (Exception ignored) {
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    MainActivity.this.startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (dialog, which) -> result.confirm())
                        .setNegativeButton("取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                if (defaultValue != null) {
                    input.setText(defaultValue);
                    input.setSelection(input.getText().length());
                }
                FrameLayout container = new FrameLayout(MainActivity.this);
                int padding = (int) (getResources().getDisplayMetrics().density * 16);
                container.setPadding(padding, padding / 2, padding, 0);
                container.addView(input, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(message)
                        .setView(container)
                        .setPositiveButton("确定", (dialog, which) -> result.confirm(input.getText().toString()))
                        .setNegativeButton("取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(TAG, consoleMessage.message() + " @ " + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber());
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                rootLayout.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                hideSystemBars();
            }

            @Override
            public void onHideCustomView() {
                hideCustomViewInternal();
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (resultMsg == null || resultMsg.obj == null) {
                    return false;
                }
                popupWebView = new WebView(MainActivity.this);
                popupWebView.getSettings().setJavaScriptEnabled(true);
                popupWebView.setVisibility(View.INVISIBLE);
                // 必须挂到视图树上才会真正发起请求，用 1x1 的不可见尺寸兜住 target=_blank
                FrameLayout.LayoutParams popupParams = new FrameLayout.LayoutParams(1, 1);
                popupParams.leftMargin = -2;
                popupParams.topMargin = -2;
                rootLayout.addView(popupWebView, popupParams);
                popupWebView.setWebViewClient(new WebViewClientCompat() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView popup, WebResourceRequest request) {
                        openExternal(request.getUrl());
                        destroyPopupWebView();
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView popup, String url, android.graphics.Bitmap favicon) {
                        // 少数情况下（例如 about:blank 直接脚本跳转）拿不到 shouldOverrideUrlLoading
                        Uri started = Uri.parse(url == null ? "" : url);
                        String scheme = started.getScheme() == null ? "" : started.getScheme().toLowerCase();
                        if (APP_HOST.equals(started.getHost())) {
                            return;
                        }
                        if ("http".equals(scheme) || "https".equals(scheme)) {
                            openExternal(started);
                            destroyPopupWebView();
                        }
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popupWebView);
                resultMsg.sendToTarget();
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                handleDownload(url, userAgent, contentDisposition, mimeType));
    }
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (filePathCallback == null) {
            return;
        }
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{ data.getData() };
            }
        }
        // 无论是选中还是取消，都要回调一次，否则页面里的 <input type=file> 会一直锁死
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    private void destroyPopupWebView() {
        if (popupWebView == null) {
            return;
        }
        WebView popup = popupWebView;
        popupWebView = null;
        if (popup.getParent() instanceof ViewGroup) {
            ((ViewGroup) popup.getParent()).removeView(popup);
        }
        popup.loadUrl("about:blank");
        popup.destroy();
    }

    private void hideCustomViewInternal() {
        if (customView == null) {
            return;
        }
        rootLayout.removeView(customView);
        customView = null;
        webView.setVisibility(View.VISIBLE);
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        hideSystemBars();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    private void hideIme() {
        View focus = getCurrentFocus() != null ? getCurrentFocus() : webView;
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null && focus != null) {
            imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
        }
        if (webView != null) {
            webView.clearFocus();
        }
    }

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBackPressed);
        }
    }

    /**
     * 返回键统一入口：全屏视频 -> 收起键盘 -> 由网页处理（关闭弹层 / 返回上一屏）-> 退出应用。
     */
    private void handleBackPressed() {
        if (customView != null) {
            hideCustomViewInternal();
            return;
        }
        if (imeVisible) {
            hideIme();
            return;
        }
        if (popupWebView != null) {
            destroyPopupWebView();
            return;
        }
        if (backPending) {
            return;
        }
        if (webView == null || !pageReady) {
            finish();
            return;
        }
        backPending = true;
        webView.evaluateJavascript(JS_BACK, value -> {
            backPending = false;
            String result = value == null ? "" : value.replace("\"", "").trim();

            // 网页已处理：关闭弹层 / 回到上一页，原生层什么都不做
            if ("handled".equals(result) || "true".equals(result)) {
                lastBackAt = 0L;
                return;
            }

            // 网页明确表示已经在桌面：二次确认后退出
            if ("exit".equals(result)) {
                confirmExit();
                return;
            }

            // 其余情况（网页没找到可返回的东西）：先尝试 WebView 历史，再提示
            if (webView.canGoBack()) {
                webView.goBack();
                lastBackAt = 0L;
                return;
            }
            confirmExit();
        });
    }

    /** 两次返回才退出，第一次只提示——保证手势返回永远不会“一下就退出” */
    private void confirmExit() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastBackAt < 2000L) {
            finish();
        } else {
            lastBackAt = now;
            Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBackPressed();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && !imeVisible) {
            hideSystemBars();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (rootLayout != null) {
            rootLayout.postDelayed(this::hideSystemBars, 100);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        destroyPopupWebView();
        if (webView != null) {
            if (rootLayout != null) {
                rootLayout.removeView(webView);
            }
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void openExternal(Uri uri) {
        if (uri == null) {
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        }
    }

    private void handleDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (url == null) {
            return;
        }
        final String safeUrl = url;
        final String safeAgent = userAgent;
        final String safeDisposition = contentDisposition;
        final String safeMime = mimeType;
        new Thread(() -> {
            String name = "download.bin";
            try {
                name = URLUtil.guessFileName(safeUrl, safeDisposition, safeMime);
                nativeBridge.saveUrlToDownloads(safeUrl, safeAgent, name, safeMime);
                final String saved = name;
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "已保存到 下载/EPhone/" + saved, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.w(TAG, "download failed: " + safeUrl, e);
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }, "ephone-download").start();
    }
}

