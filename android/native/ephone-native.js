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
    window.__EPHONE_NATIVE_VERSION = '1.1.0';

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
    var MAX_NAV_STACK = 60;

    // 手机外壳容器：这些元素常驻 active，不能当成“页面”
    var SHELL_IDS = { 'phone-screen': 1, 'character-phone-screen': 1 };

    function isShellScreen(id) {
        return !id || SHELL_IDS[id] === 1;
    }

    /** 当前真正显示的页面：取 DOM 顺序里最后一个可见的 .screen/.char-screen */
    function currentScreenId() {
        var nodes = document.querySelectorAll('.screen.active, .char-screen.active');
        var best = '';
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (isShellScreen(node.id)) { continue; }
            if (!isDisplayed(node)) { continue; }
            best = node.id;
        }
        return best;
    }

    function recordScreen(id) {
        if (isShellScreen(id) || !document.getElementById(id)) { return; }
        if (navStack[navStack.length - 1] === id) { return; }
        var index = navStack.lastIndexOf(id);
        if (index >= 0) {
            // 用户自己点返回回到了更早的页面，栈同步截断
            navStack = navStack.slice(0, index + 1);
            return;
        }
        navStack.push(id);
        if (navStack.length > MAX_NAV_STACK) {
            navStack = navStack.slice(navStack.length - MAX_NAV_STACK);
        }
        // 切页后顺手检查一次图标兜底（外链图标在国内可能永远不回来）
        try { window.setTimeout(ensureLocalIcons, 300); } catch (e) {}
    }

    /**
     * 包一层 showScreen / switchToCharScreen / switchToCharHomeScreen，
     * 用真实调用记录页面栈——比监听 DOM 变化可靠，也不依赖“模拟点击按钮”。
     */
    function wrapNavFunction(name, fixedId) {
        var original = window[name];
        var wrapper = null;

        function make(fn) {
            if (typeof fn !== 'function') { return fn; }
            return function () {
                var result = fn.apply(this, arguments);
                try { recordScreen(fixedId || arguments[0]); } catch (e) {}
                return result;
            };
        }

        if (typeof original === 'function') { wrapper = make(original); }

        try {
            Object.defineProperty(window, name, {
                configurable: true,
                enumerable: true,
                get: function () { return wrapper || original; },
                set: function (value) {
                    original = value;
                    wrapper = make(value);
                }
            });
        } catch (e) {
            try { window[name] = make(original); } catch (ignored) {}
        }
    }

    wrapNavFunction('showScreen');
    wrapNavFunction('switchToCharScreen');
    wrapNavFunction('switchToCharHomeScreen', 'char-home-screen');

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

    function navigateTo(id) {
        var target = document.getElementById(id);
        if (!target) { return false; }
        try {
            if (target.classList.contains('char-screen')) {
                if (id === 'char-home-screen' && typeof window.switchToCharHomeScreen === 'function') {
                    window.switchToCharHomeScreen();
                    return true;
                }
                if (typeof window.switchToCharScreen === 'function') {
                    window.switchToCharScreen(id);
                    return true;
                }
            } else if (typeof window.showScreen === 'function') {
                window.showScreen(id);
                return true;
            }
        } catch (e) {
            log('navigateTo failed', id, e);
        }
        return activateScreenFallback(id);
    }

    function cancelSelectionIfAny() {
        var button = document.getElementById('selection-cancel-btn');
        if (button && isDisplayed(button)) {
            button.click();
            return true;
        }
        return false;
    }

    var BACK_BUTTON_SELECTOR = '.back-btn, [id$="-back-btn"], #back-to-list-btn, [class*="back-button"], [data-action="back"]';

    /** 全局兜底：找当前可见区域内真正显示的返回按钮 */
    function findVisibleBackButtonAnywhere() {
        var buttons = document.querySelectorAll(BACK_BUTTON_SELECTOR);
        for (var i = 0; i < buttons.length; i++) {
            if (isDisplayed(buttons[i])) { return buttons[i]; }
        }
        return null;
    }

    function isRootScreen(id) {
        return !id || id === 'home-screen';
    }

    function finishBack(info) {
        window.__ephoneLastBack = info;
        if (info.via === 'exit') { return 'exit'; }
        if (!info.via || info.via === 'none') { return 'none'; }
        return 'handled';
    }

    /**
     * 返回键统一处理，返回值约定：
     *   'handled' —— 已关闭弹层 / 已回到上一页，原生层不要做任何事
     *   'exit'    —— 已经在最外层（桌面），允许“再按一次退出”
     *   'none'    —— 没找到可返回的东西，原生层只提示、不退出
     */
    function handleBack() {
        var info = { via: 'none' };
        try {
            if (cancelSelectionIfAny()) { info.via = 'selection'; return finishBack(info); }
            if (closeVisibleOverlay()) { info.via = 'overlay'; return finishBack(info); }

            var current = currentScreenId();
            if (current) {
                if (!navStack.length) {
                    navStack = [current];
                } else if (navStack[navStack.length - 1] !== current) {
                    // 栈和界面不一致时以界面为准，避免一次返回跳错页
                    var existing = navStack.lastIndexOf(current);
                    if (existing >= 0) {
                        navStack = navStack.slice(0, existing + 1);
                    } else {
                        navStack.push(current);
                    }
                }
            }

            if (navStack.length > 1) {
                navStack.pop();
                var target = navStack[navStack.length - 1];
                if (navigateTo(target)) {
                    info.via = 'stack';
                    info.from = current;
                    info.to = target;
                    return finishBack(info);
                }
                navStack.push(current);
            }

            // 有些页面不走 showScreen（例如聊天设置面板），退回点击页面内返回按钮
            var screen = document.getElementById(current) || topActiveScreen();
            var backButton = findBackButton(screen);
            if (backButton) {
                backButton.click();
                info.via = 'button';
                info.from = current;
                return finishBack(info);
            }

            var globalBackButton = findVisibleBackButtonAnywhere();
            if (globalBackButton) {
                globalBackButton.click();
                info.via = 'global-button';
                info.from = current;
                return finishBack(info);
            }

            if (isRootScreen(current)) { info.via = 'exit'; }
            return finishBack(info);
        } catch (e) {
            log('handleBack failed', e);
            window.__ephoneLastBack = { via: 'error', message: String(e && e.message || e) };
            return 'none';
        }
    }

    window.__ephoneHandleBack = handleBack;

    /* ---------------- 9. 记录屏幕栈 ---------------- */

    var trackTimer = null;

    function scheduleTrack() {
        if (trackTimer) { return; }
        trackTimer = window.setTimeout(function () {
            trackTimer = null;
            recordScreen(currentScreenId());
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

    // 兜底：有些页面用 style.display 切换，MutationObserver 抓不到 class 以外的情况
    window.setInterval(function () {
        if (document.hidden) { return; }
        recordScreen(currentScreenId());
    }, 1500);

    /* ---------------- 10. 远程图片兜底 ---------------- */
    // 这些图床在国内网络经常加载失败（APK 内又禁用了 Service Worker 缓存），
    // 失败时自动改走图片代理，仍然失败就隐藏，避免出现破图。
    var IMAGE_PROXY_HOSTS = /(^|\.)(postimg\.cc|imgur\.com|catbox\.moe|s3plus\.meituan\.net|static\.eeo\.cn)$/i;

    // 这三个按钮的图标被 App 运行时换成外链，国内网络/APK 里会加载不出来，
    // 对应本地文件已经打进 APK，加载失败时直接换成本地图。
    var LOCAL_ICON_FALLBACKS = {
        'listen-together-btn': '210-20250618115221.png',
        'chat-settings-btn': 'CCA834-BA-5-A90-408-D-94-FA-7-EE156-B6-A765.png',
        'wait-reply-btn': 'ECE92-BBC-BE57-48-E9-BB2-C-345-B6019-C4-B2.png'
    };

    function localIconFor(img) {
        if (!img || !img.closest) { return ''; }
        var holder = img.closest('#listen-together-btn, #chat-settings-btn, #wait-reply-btn');
        return holder ? (LOCAL_ICON_FALLBACKS[holder.id] || '') : '';
    }

    function applyLocalIcon(img) {
        var local = localIconFor(img);
        if (!local || img.__ephoneLocalIconApplied) { return false; }
        img.__ephoneLocalIconApplied = true;
        img.setAttribute('src', local);
        return true;
    }

    function ensureLocalIcons() {
        Object.keys(LOCAL_ICON_FALLBACKS).forEach(function (id) {
            var holder = document.getElementById(id);
            var img = holder && holder.querySelector('img');
            if (!img || img.naturalWidth > 0) { return; }
            var src = img.getAttribute('src') || '';
            if (src && !/^https?:\/\//i.test(src)) { return; }
            applyLocalIcon(img);
        });
    }

    // 外链图片可能既不报错也不回来，定时兜一次
    window.setTimeout(ensureLocalIcons, 2500);
    window.setTimeout(ensureLocalIcons, 6000);
    window.setTimeout(ensureLocalIcons, 12000);

    function proxiedImageUrl(url) {
        return 'https://images.weserv.nl/?url=' + encodeURIComponent(url.replace(/^https?:\/\//i, ''));
    }

    document.addEventListener('error', function (event) {
        var img = event.target;
        if (!img || img.tagName !== 'IMG') { return; }
        var src = img.getAttribute('src') || '';
        if (!/^https?:\/\//i.test(src)) { return; }
        if (applyLocalIcon(img)) { return; }
        if (!img.__ephoneProxyTried) {
            img.__ephoneProxyTried = true;
            try {
                var host = new URL(src).hostname;
                if (IMAGE_PROXY_HOSTS.test(host)) {
                    img.setAttribute('src', proxiedImageUrl(src));
                    return;
                }
            } catch (e) {}
        }
        img.style.visibility = 'hidden';
    }, true);
})();
