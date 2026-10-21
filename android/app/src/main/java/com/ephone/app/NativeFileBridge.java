package com.ephone.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 暴露给网页的 window.AndroidApp 桥。
 *
 * 写文件流程（配合 native/ephone-native.js）：
 *   var res = JSON.parse(AndroidApp.beginSave('xxx.json', 'application/json'));
 *   AndroidApp.appendChunk(res.id, base64Chunk);   // 可多次
 *   AndroidApp.finishSave(res.id);                 // 落盘到 下载/EPhone/
 *   AndroidApp.abortSave(res.id);                  // 出错时丢弃
 *
 * 所有返回值都是 JSON 字符串，避免 WebView 吞掉 Java 异常信息。
 */
public class NativeFileBridge {
    private static final String TAG = "EPhoneBridge";
    private static final String FOLDER = "EPhone";
    private static final int MAX_SESSIONS = 8;
    private static final int COPY_BUFFER = 128 * 1024;

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicInteger idGenerator = new AtomicInteger(0);
    private final Map<String, SaveSession> sessions = new HashMap<>();

    public NativeFileBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    private static final class SaveSession {
        final String id;
        final String name;
        final Uri uri;
        final OutputStream out;
        long written;

        SaveSession(String id, String name, Uri uri, OutputStream out) {
            this.id = id;
            this.name = name;
            this.uri = uri;
            this.out = out;
        }
    }

    /* ---------------- 提示 ---------------- */

    @JavascriptInterface
    public void toast(final String message) {
        if (message == null) {
            return;
        }
        mainHandler.post(() -> Toast.makeText(context, message, Toast.LENGTH_SHORT).show());
    }
    /* ---------------- 分块保存 ---------------- */

    @JavascriptInterface
    public String beginSave(String rawName, String mimeType) {
        String name = safeName(rawName);
        String mime = (mimeType == null || mimeType.isEmpty()) ? guessMime(name) : mimeType;
        synchronized (sessions) {
            if (sessions.size() >= MAX_SESSIONS) {
                abortAllLocked();
            }
            Uri uri = null;
            OutputStream out = null;
            try {
                ContentResolver resolver = context.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + File.separator + FOLDER);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    return error("无法在“下载/" + FOLDER + "”中创建文件");
                }
                out = resolver.openOutputStream(uri, "w");
                if (out == null) {
                    resolver.delete(uri, null, null);
                    return error("无法写入文件");
                }
                String id = "save" + idGenerator.incrementAndGet();
                sessions.put(id, new SaveSession(id, name, uri, new BufferedOutputStream(out, COPY_BUFFER)));
                return "{\"ok\":true,\"id\":\"" + id + "\",\"name\":\"" + jsonEscape(name)
                        + "\",\"mime\":\"" + jsonEscape(mime) + "\"}";
            } catch (Exception e) {
                Log.w(TAG, "beginSave failed", e);
                closeQuietly(out);
                if (uri != null) {
                    try {
                        context.getContentResolver().delete(uri, null, null);
                    } catch (Exception ignored) {
                    }
                }
                return error(messageOf(e));
            }
        }
    }

    @JavascriptInterface
    public String appendChunk(String id, String base64Chunk) {
        if (base64Chunk == null || base64Chunk.isEmpty()) {
            return ok();
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64Chunk, Base64.NO_WRAP);
        } catch (Exception e) {
            return error("数据块解析失败");
        }
        synchronized (sessions) {
            SaveSession session = sessions.get(id);
            if (session == null) {
                return error("写入会话已失效");
            }
            try {
                session.out.write(bytes);
                session.written += bytes.length;
                return ok();
            } catch (Exception e) {
                Log.w(TAG, "appendChunk failed", e);
                abortLocked(id, true);
                return error(messageOf(e));
            }
        }
    }

    @JavascriptInterface
    public String finishSave(String id) {
        synchronized (sessions) {
            SaveSession session = sessions.get(id);
            if (session == null) {
                return error("写入会话已失效");
            }
            sessions.remove(id);
            try {
                session.out.flush();
                session.out.close();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                context.getContentResolver().update(session.uri, values, null, null);
                return "{\"ok\":true,\"name\":\"" + jsonEscape(session.name)
                        + "\",\"size\":" + session.written
                        + ",\"folder\":\"下载/" + FOLDER + "/\"}";
            } catch (Exception e) {
                Log.w(TAG, "finishSave failed", e);
                try {
                    context.getContentResolver().delete(session.uri, null, null);
                } catch (Exception ignored) {
                }
                return error(messageOf(e));
            }
        }
    }

    @JavascriptInterface
    public String abortSave(String id) {
        synchronized (sessions) {
            abortLocked(id, true);
        }
        return ok();
    }
    /* ---------------- 针对 URL 的下载（DownloadListener / window.open） ---------------- */

    /**
     * 把 url 指向的内容直接保存进 下载/EPhone/，支持 http(s)、data: 和 content: 地址。
     * 供 MainActivity 的 DownloadListener 与 JS 的 downloadUrl 调用。
     */
    public void saveUrlToDownloads(String url, String userAgent, String name, String mimeType) throws IOException {
        String safe = safeName(name);
        String mime = (mimeType == null || mimeType.isEmpty()) ? guessMime(safe) : mimeType;
        ContentResolver resolver = context.getContentResolver();
        Uri uri = null;
        OutputStream raw = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + File.separator + FOLDER);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("无法创建下载文件");
            }
            raw = resolver.openOutputStream(uri, "w");
            if (raw == null) {
                throw new IOException("无法写入下载文件");
            }
            OutputStream out = new BufferedOutputStream(raw, COPY_BUFFER);
            if (url.startsWith("data:")) {
                writeDataUrl(url, out);
            } else if (url.startsWith("content:") || url.startsWith("file:")) {
                try (InputStream in = resolver.openInputStream(Uri.parse(url))) {
                    if (in == null) {
                        throw new IOException("无法读取文件");
                    }
                    copyStream(in, out);
                }
            } else {
                copyFromNetwork(url, userAgent, out);
            }
            out.flush();
            out.close();
            raw = null;

            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            uri = null;
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException(messageOf(e));
        } finally {
            closeQuietly(raw);
            if (uri != null) {
                try {
                    resolver.delete(uri, null, null);
                } catch (Exception ignored) {
                }
            }
        }
    }

    @JavascriptInterface
    public String downloadUrl(final String url, final String name) {
        if (url == null || url.isEmpty()) {
            return error("下载地址为空");
        }
        if (url.startsWith("blob:")) {
            return error("blob 地址无法直接下载，请使用分块保存接口");
        }
        final String finalName = safeName(name);
        new Thread(() -> {
            try {
                saveUrlToDownloads(url, null, finalName, guessMime(finalName));
                toast("已保存到 下载/" + FOLDER + "/" + finalName);
            } catch (Exception e) {
                Log.w(TAG, "downloadUrl failed", e);
                toast("下载失败：" + messageOf(e));
            }
        }, "ephone-download-url").start();
        return ok();
    }

    private void copyFromNetwork(String url, String userAgent, OutputStream out) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("User-Agent",
                    userAgent == null || userAgent.isEmpty() ? "Mozilla/5.0 (Linux; Android) EPhone" : userAgent);
            int code = connection.getResponseCode();
            if (code >= 400) {
                throw new IOException("服务器返回 " + code);
            }
            try (InputStream in = connection.getInputStream()) {
                copyStream(in, out);
            }
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException(messageOf(e));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void copyStream(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[COPY_BUFFER];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }

    private void writeDataUrl(String url, OutputStream out) throws IOException {
        int comma = url.indexOf(',');
        if (comma < 0) {
            throw new IOException("数据地址无效");
        }
        String meta = url.substring(5, comma);
        String payload = url.substring(comma + 1);
        if (meta.toLowerCase().contains(";base64")) {
            out.write(Base64.decode(payload, Base64.DEFAULT));
        } else {
            out.write(URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8"));
        }
    }
    /* ---------------- 工具方法 ---------------- */

    private void abortLocked(String id, boolean deleteRow) {
        SaveSession session = sessions.remove(id);
        if (session == null) {
            return;
        }
        closeQuietly(session.out);
        if (deleteRow) {
            try {
                context.getContentResolver().delete(session.uri, null, null);
            } catch (Exception ignored) {
            }
        }
    }

    private void abortAllLocked() {
        for (String key : sessions.keySet().toArray(new String[0])) {
            abortLocked(key, true);
        }
        sessions.clear();
    }

    private static void closeQuietly(OutputStream out) {
        if (out == null) {
            return;
        }
        try {
            out.close();
        } catch (Exception ignored) {
        }
    }

    private static String ok() {
        return "{\"ok\":true}";
    }

    private static String error(String message) {
        return "{\"ok\":false,\"error\":\"" + jsonEscape(message == null ? "未知错误" : message) + "\"}";
    }

    private static String jsonEscape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    builder.append("\\\"");
                    break;
                case '\\':
                    builder.append("\\\\");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        builder.append(String.format("\\u%04x", (int) c));
                    } else {
                        builder.append(c);
                    }
            }
        }
        return builder.toString();
    }

    private static String messageOf(Throwable error) {
        if (error == null) {
            return "未知错误";
        }
        String message = error.getMessage();
        if (message == null || message.isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message;
    }

    private static String safeName(String rawName) {
        String name = rawName == null ? "" : rawName.trim();
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        name = name.replaceAll("[\\p{Cntrl}\"<>|:*?]", "_");
        name = name.replaceAll("^[.\\s]+", "");
        if (name.isEmpty()) {
            name = "ephone-" + System.currentTimeMillis() + ".txt";
        }
        if (name.length() > 120) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 ? name.substring(dot) : "";
            name = name.substring(0, Math.max(1, 120 - ext.length())) + ext;
        }
        return name;
    }

    private static String guessMime(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        switch (ext) {
            case "json":
                return "application/json";
            case "txt":
            case "md":
                return "text/plain";
            case "html":
            case "htm":
                return "text/html";
            case "css":
                return "text/css";
            case "js":
                return "application/javascript";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "webp":
                return "image/webp";
            case "gif":
                return "image/gif";
            case "svg":
                return "image/svg+xml";
            case "pdf":
                return "application/pdf";
            case "mp3":
                return "audio/mpeg";
            case "m4a":
                return "audio/mp4";
            case "wav":
                return "audio/wav";
            case "ogg":
                return "audio/ogg";
            case "mp4":
                return "video/mp4";
            case "webm":
                return "video/webm";
            case "zip":
                return "application/zip";
            case "epub":
                return "application/epub+zip";
            default:
                return "application/octet-stream";
        }
    }
}