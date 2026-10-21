/*
 * EPhone Android 原生增强层 1.0.0
 * 仅在 APK（window.AndroidApp 存在）中启用；浏览器直接访问时不做任何修改。
 *
 * 功能：
 *   1. 禁用/清理 Service Worker，避免 APK 内的旧缓存盖住新资源；
 *   2. 接管 StreamSaver / <a download> / window.open(blob:) / WebView 下载，
 *      统一保存到「下载/EPhone/」；
 *   3. 提供 window.__ephoneHandleBack()，把系统返回手势映射成应用内返回。
 */
(function () {
    'use strict';

    var bridge = window.AndroidApp || null;
    if (!bridge) { return; }

    window.__EPHONE_NATIVE__ = true;
    window.__EPHONE_NATIVE_VERSION = '1.0.0';

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[EPhoneNative]');
            console.log.apply(console, args);
        } catch (e) {}
    }

    function toast(message) {
        try {
            if (bridge.toast) { bridge.toast(String(message)); }
        } catch (e) {}
    }

    /* ---------------- 1.5 原生桥返回值解析 ---------------- */

    // Java 端所有方法都返回 JSON 字符串（见 NativeFileBridge.java）
    function parseBridgeResult(raw) {
        if (raw == null) { return { ok: false, error: '原生接口无响应' }; }
        if (typeof raw === 'object') { return raw; }
        var text = String(raw);
        try {
            var parsed = JSON.parse(text);
            return (parsed && typeof parsed === 'object') ? parsed : { ok: true, value: parsed };
        } catch (e) {
            return { ok: false, error: text };
        }
    }

    function beginSaveSession(name, mime) {
        var result = parseBridgeResult(bridge.beginSave(name, mime));
        if (!result.ok || !result.id) {
            throw new Error(result.error || '无法创建保存文件');
        }
        return result.id;
    }

    function appendSessionChunk(id, base64) {
        var result = parseBridgeResult(bridge.appendChunk(id, base64));
        if (!result.ok) {
            throw new Error(result.error || '写入文件失败');
        }
    }

    function finishSaveSession(id) {
        var result = parseBridgeResult(bridge.finishSave(id));
        if (!result.ok) {
            throw new Error(result.error || '保存文件失败');
        }
        return result;
    }

    function abortSaveSession(id) {
        try { bridge.abortSave(id); } catch (e) {}
    }

    /* ---------------- 1.6 Service Worker ---------------- */

    try {
        if (navigator.serviceWorker && navigator.serviceWorker.register) {
            navigator.serviceWorker.register = function () {
                return Promise.reject(new Error('service worker disabled in the native app'));
            };
        }
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            navigator.serviceWorker.getRegistrations().then(function (list) {
                list.forEach(function (reg) {
                    try { reg.unregister(); } catch (e) {}
                });
            }).catch(function () {});
        }
    } catch (e) {
        log('service worker patch failed', e);
    }

    try {
        if (window.caches && caches.keys) {
            caches.keys().then(function (keys) {
                keys.forEach(function (key) {
                    try { caches.delete(key); } catch (e) {}
                });
            }).catch(function () {});
        }
    } catch (e) {}

    /* ---------------- 2. 视口修正 ---------------- */

    function applyNativeStyle() {
        if (document.getElementById('ephone-native-style')) { return; }
        var style = document.createElement('style');
        style.id = 'ephone-native-style';
        // 100vh 在 WebView 里不会随软键盘收缩，改成跟随容器高度
        style.textContent = '#phone-screen{height:100% !important;}html,body{overscroll-behavior:none;}';
        (document.head || document.documentElement).appendChild(style);
    }

    applyNativeStyle();

    /* ---------------- 3. 文件保存 ---------------- */

    function readBlobAsArrayBuffer(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(reader.error || new Error('读取文件失败')); };
            reader.readAsArrayBuffer(blob);
        });
    }

    function bytesToBase64(bytes) {
        var binary = '';
        var chunkSize = 0x8000;
        for (var i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return window.btoa(binary);
    }

    function sanitizeFileName(name) {
        var result = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\s+|\s+$/g, '');
        if (!result) { result = 'ephone-' + Date.now(); }
        if (result.length > 120) {
            var dot = result.lastIndexOf('.');
            if (dot > 0 && result.length - dot <= 12) {
                result = result.slice(0, 108) + result.slice(dot);
            } else {
                result = result.slice(0, 120);
            }
        }
        return result;
    }
    function guessExtension(mime) {
        var map = {
            'application/zip': '.zip',
            'application/json': '.json',
            'application/pdf': '.pdf',
            'text/plain': '.txt',
            'text/markdown': '.md',
            'text/csv': '.csv',
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'audio/mpeg': '.mp3',
            'audio/wav': '.wav',
            'video/mp4': '.mp4'
        };
        return map[mime] || '';
    }

    function guessMime(fileName) {
        var ext = String(fileName || '').toLowerCase().split('.').pop();
        var map = {
            zip: 'application/zip',
            json: 'application/json',
            pdf: 'application/pdf',
            txt: 'text/plain',
            md: 'text/markdown',
            csv: 'text/csv',
            html: 'text/html',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            mp4: 'video/mp4'
        };
        return map[ext] || 'application/octet-stream';
    }

    function saveBlob(blob, fileName) {
        var name = sanitizeFileName(fileName || ('ephone-' + Date.now() + guessExtension(blob && blob.type)));
        var mime = (blob && blob.type) || guessMime(name);

        return new Promise(function (resolve, reject) {
            var id = '';
            try {
                id = beginSaveSession(name, mime);
            } catch (e) {
                reject(e);
                return;
            }

            var total = blob.size || 0;
            var offset = 0;
            var chunkSize = 256 * 1024;

            function next() {
                if (offset >= total) {
                    try {
                        finishSaveSession(id);
                        resolve(true);
                    } catch (e) {
                        reject(e);
                    }
                    return;
                }
                var part = blob.slice(offset, offset + chunkSize);
                offset += chunkSize;
                readBlobAsArrayBuffer(part).then(function (buffer) {
                    appendSessionChunk(id, bytesToBase64(new Uint8Array(buffer)));
                    next();
                }).catch(function (err) {
                    abortSaveSession(id);
                    reject(err);
                });
            }

            next();
        });
    }

    function saveUrl(url, fileName) {
        return fetch(url).then(function (response) {
            return response.blob();
        }).then(function (blob) {
            var name = fileName;
            if (!name) {
                var match = /^data:([^;,]+)/i.exec(url);
                name = 'ephone-' + Date.now() + guessExtension(match ? match[1] : blob.type);
            }
            return saveBlob(blob, name);
        });
    }

    window.__ephoneSaveUrl = function (url, fileName) {
        if (!url) { return false; }
        saveUrl(url, fileName).then(function () {
            toast('已保存到 下载/EPhone');
        }).catch(function (err) {
            toast('保存失败: ' + (err && err.message ? err.message : err));
        });
        return true;
    };

    function nameFromUrl(url) {
        try {
            var parsed = new URL(url, location.href);
            var parts = parsed.pathname.split('/').filter(Boolean);
            var last = parts[parts.length - 1];
            if (last) { return decodeURIComponent(last); }
        } catch (e) {}
        return '';
    }

    /* ---------------- 4. StreamSaver 接管 ---------------- */

    function chunkToBytes(chunk) {
        if (chunk instanceof Uint8Array) { return chunk; }
        if (chunk && chunk.buffer) { return new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength); }
        if (typeof chunk === 'string') { return new TextEncoder().encode(chunk); }
        return new Uint8Array(chunk);
    }

    function patchStreamSaver(instance) {
        if (!instance || typeof instance.createWriteStream !== 'function' || instance.__ephoneNativePatched) {
            return instance;
        }
        try {
            var originalCreateWriteStream = instance.createWriteStream.bind(instance);
            instance.createWriteStream = function (fileName, options) {
                if (typeof WritableStream === 'undefined') {
                    return originalCreateWriteStream(fileName, options);
                }
                var name = sanitizeFileName(fileName || ('ephone-export-' + Date.now() + '.zip'));
                var mime = guessMime(name);
                var id = '';
                var closed = false;
                try {
                    id = beginSaveSession(name, mime);
                } catch (e) {
                    log('beginSave failed', e);
                }
                return new WritableStream({
                    start: function () {
                        if (!id) { throw new Error('无法创建保存文件'); }
                    },
                    write: function (chunk) {
                        if (!id || closed) { return; }
                        try {
                            appendSessionChunk(id, bytesToBase64(chunkToBytes(chunk)));
                        } catch (e) {
                            closed = true;
                            abortSaveSession(id);
                            throw e;
                        }
                    },
                    close: function () {
                        if (id && !closed) {
                            closed = true;
                            try {
                                finishSaveSession(id);
                            } catch (e) {
                                log('finishSave failed', e);
                            }
                        }
                    },
                    abort: function () {
                        if (id && !closed) {
                            closed = true;
                            abortSaveSession(id);
                        }
                    }
                });
            };
            instance.__ephoneNativePatched = true;
            log('StreamSaver 已接管');
        } catch (e) {
            log('StreamSaver patch failed', e);
        }
        return instance;
    }

    ['streamSaver', 'StreamSaver'].forEach(function (key) {
        var current = window[key];
        if (current) { patchStreamSaver(current); }
        try {
            Object.defineProperty(window, key, {
                configurable: true,
                enumerable: true,
                get: function () { return current; },
                set: function (value) { current = patchStreamSaver(value); }
            });
        } catch (e) {
            log('cannot hook window.' + key, e);
        }
    });

    /* ---------------- 5. <a download> / window.open ---------------- */

    function downloadViaAnchor(anchor) {
        if (!anchor || typeof anchor.hasAttribute !== 'function') { return false; }
        if (!anchor.hasAttribute('download')) { return false; }
        var href = anchor.getAttribute('href') || '';
        if (!href) { return false; }
        var fileName = anchor.getAttribute('download') || nameFromUrl(href);

        if (/^blob:/i.test(href) || /^data:/i.test(href)) {
            saveUrl(href, fileName).then(function () {
                toast('已保存到 下载/EPhone');
            }).catch(function (err) {
                toast('保存失败: ' + (err && err.message ? err.message : err));
            });
            return true;
        }
        if (/^https?:/i.test(href) && bridge.downloadUrl) {
            try {
                bridge.downloadUrl(new URL(href, location.href).href, fileName);
                return true;
            } catch (e) {}
        }
        return false;
    }

    var nativeAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (downloadViaAnchor(this)) { return; }
        return nativeAnchorClick.apply(this, arguments);
    };

    document.addEventListener('click', function (event) {
        var target = event.target;
        var anchor = target && target.closest ? target.closest('a[download]') : null;
        if (anchor && downloadViaAnchor(anchor)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    var nativeWindowOpen = window.open;
    window.open = function (url) {
        if (typeof url === 'string' && /^(blob|data):/i.test(url)) {
            window.__ephoneSaveUrl(url, nameFromUrl(url));
            // 返回一个空壳窗口对象，避免调用方对返回值直接取属性时抛错
            return {
                closed: false,
                focus: function () {},
                blur: function () {},
                close: function () {},
                postMessage: function () {},
                location: { href: url },
                document: { write: function () {}, close: function () {}, open: function () { return this; } }
            };
        }
        return nativeWindowOpen.apply(window, arguments);
    };

    /* ---------------- 6. 可见性判断 ---------------- */

    function isDisplayed(element) {
        if (!element || element.nodeType !== 1) { return false; }
        for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
            var style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') { return false; }
            if (node !== element && parseFloat(style.opacity || '1') <= 0.01) { return false; }
        }
        if (!element.getClientRects().length) { return false; }
        var own = window.getComputedStyle(element);
        if (parseFloat(own.opacity || '1') > 0.01) { return true; }
        return element.classList.contains('active') || element.classList.contains('visible');
    }

    function topActiveScreen() {
        var nodes = document.querySelectorAll('.screen.active, .char-screen.active');
        var best = null;
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!isDisplayed(node)) { continue; }
            var nested = node.querySelector('.screen.active, .char-screen.active');
            if (nested && isDisplayed(nested)) { continue; }
            best = node;
        }
        return best;
    }

    function clickIfDisplayed(selector) {
        var element = document.querySelector(selector);
        if (element && isDisplayed(element)) {
            element.click();
            return true;
        }
        return false;
    }

    /* ---------------- 7. 关闭弹层 ---------------- */

    var PANEL_CLOSE_BUTTONS = {
        '#nai-gallery-panel': ['#close-nai-gallery-btn'],
        '#music-player-overlay': ['#music-return-btn', '#music-exit-btn'],
        '#reading-overlay': ['#close-reading-btn', '#minimize-reading-btn', '#close-reading-library-btn-header'],
        '#gr-sidebar-overlay': [],
        '#chat-lock-overlay': []
    };

    // 只认「关闭语义」的按钮，避免把「确定 / OK」当成关闭而误提交表单
    var CLOSE_LABEL_PATTERN = /(^|[^a-z])(close|dismiss|cancel)([^a-z]|$)|关闭|取消|返回|退出|收起|×|✕/i;

    var MODAL_CONTAINER_SELECTOR = [
        '.modal',
        '.modal-overlay',
        '.overlay',
        '.popup',
        '.popup-overlay',
        '.sheet',
        '[id$="-modal"]',
        '[id$="-overlay"]',
        '[id$="-panel"]'
    ].join(',');

    function clickCloseButtonInside(container) {
        var buttons = container.querySelectorAll(
                'button, [role="button"], .close-btn, .panel-btn, [id*="close"], [id*="cancel"]');
        for (var b = buttons.length - 1; b >= 0; b--) {
            var button = buttons[b];
            if (!isDisplayed(button)) { continue; }
            var label = ((button.id || '') + ' ' + (button.className || '') + ' ' + (button.textContent || '')).toLowerCase();
            if (CLOSE_LABEL_PATTERN.test(label)) {
                button.click();
                return true;
            }
        }
        return false;
    }

    function closeVisibleModal() {
        var customModal = document.getElementById('custom-modal-overlay');
        if (customModal && isDisplayed(customModal) && clickIfDisplayed('#custom-modal-cancel')) {
            return true;
        }

        var containers = document.querySelectorAll(MODAL_CONTAINER_SELECTOR);
        // 后出现的元素层级更高，从后往前找
        for (var i = containers.length - 1; i >= 0; i--) {
            var container = containers[i];
            if (container === customModal) { continue; }
            if (!isDisplayed(container)) { continue; }
            if (clickCloseButtonInside(container)) { return true; }
        }
        return false;
    }

    function closeVisiblePanel() {
        var selectors = Object.keys(PANEL_CLOSE_BUTTONS);
        for (var i = 0; i < selectors.length; i++) {
            var panel = document.querySelector(selectors[i]);
            if (!panel || !isDisplayed(panel)) { continue; }
            var buttonSelectors = PANEL_CLOSE_BUTTONS[selectors[i]];
            for (var b = 0; b < buttonSelectors.length; b++) {
                if (clickIfDisplayed(buttonSelectors[b])) { return true; }
            }
            if (selectors[i] === '#gr-sidebar-overlay') {
                panel.click();
                return true;
            }
        }
        return false;
    }

    function closeVisibleOverlay() {
        return closeVisibleModal() || closeVisiblePanel();
    }

    /* ---------------- 8. 返回键 ---------------- */

    function findBackButton(root) {
        if (!root) { return null; }
        var candidates = root.querySelectorAll('.back-btn, [id$="-back-btn"], #back-to-list-btn');
        for (var i = 0; i < candidates.length; i++) {
            if (isDisplayed(candidates[i])) { return candidates[i]; }
        }
        return null;
    }

    var navStack = [];

    function pushScreen(element) {
        if (!element || !element.id) { return; }
        var id = element.id;
        var index = navStack.lastIndexOf(id);
        if (index === navStack.length - 1) { return; }
        if (index >= 0) {
            navStack = navStack.slice(0, index + 1);
        } else {
            navStack.push(id);
        }
        if (navStack.length > 60) {
            navStack = navStack.slice(navStack.length - 60);
        }
    }

    function activateScreenFallback(id) {
        var target = document.getElementById(id);
        if (!target || !target.parentElement) { return false; }
        var siblings = target.parentElement.children;
        for (var i = 0; i < siblings.length; i++) {
            var sibling = siblings[i];
            if (sibling.classList && (sibling.classList.contains('screen') || sibling.classList.contains('char-screen'))) {
                sibling.classList.remove('active');
            }
        }
        target.classList.add('active');
        return true;
    }

    function goToPreviousScreen() {
        if (navStack.length <= 1) { return false; }
        navStack.pop();
        var prevId = navStack[navStack.length - 1];
        var prev = document.getElementById(prevId);
        if (!prev) { return false; }

        if (prev.classList.contains('char-screen') && typeof window.switchToCharScreen === 'function') {
            window.switchToCharScreen(prevId);
            return true;
        }
        if (!prev.classList.contains('char-screen') && typeof window.showScreen === 'function') {
            window.showScreen(prevId);
            return true;
        }
        return activateScreenFallback(prevId);
    }

    function cancelSelectionIfAny() {
        var button = document.getElementById('selection-cancel-btn');
        if (button && isDisplayed(button)) {
            button.click();
            return true;
        }
        return false;
    }

    function handleBack() {
        try {
            if (cancelSelectionIfAny()) { return true; }
            if (closeVisibleOverlay()) { return true; }

            var screen = topActiveScreen();
            var backButton = findBackButton(screen);
            if (backButton) {
                backButton.click();
                return true;
            }
            return goToPreviousScreen();
        } catch (e) {
            log('handleBack failed', e);
            return false;
        }
    }

    window.__ephoneHandleBack = handleBack;

    /* ---------------- 9. 记录屏幕栈 ---------------- */

    var trackTimer = null;

    function scheduleTrack() {
        if (trackTimer) { return; }
        trackTimer = window.setTimeout(function () {
            trackTimer = null;
            var top = topActiveScreen();
            if (top) { pushScreen(top); }
        }, 80);
    }

    function watchScreens() {
        if (typeof MutationObserver === 'undefined') { return; }
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var target = mutations[i].target;
                if (!target || target.nodeType !== 1 || !target.classList) { continue; }
                if (!target.classList.contains('screen') && !target.classList.contains('char-screen')) { continue; }
                if (target.classList.contains('active')) { scheduleTrack(); }
            }
        });
        observer.observe(document.documentElement, {
            attributes: true,
            subtree: true,
            attributeFilter: ['class']
        });
    }

    watchScreens();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleTrack);
    } else {
        scheduleTrack();
    }
    window.addEventListener('load', scheduleTrack);
})();
