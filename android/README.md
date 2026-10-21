# EPhone Android 壳（WebView → APK）

这个目录把仓库根目录的静态网页（`index.html` / `script.js` / `style.css` / `sw.js` / `manifest.json`）
原封不动地打进 APK，并在原生层补上三件事：

1. **返回手势 → 应用内返回**：`MainActivity` 把系统返回事件交给网页的 `window.__ephoneHandleBack()`，
   由 `native/ephone-native.js` 依次关闭弹层 / 点页面返回按钮 / 回退屏幕栈；网页返回 `false` 时才退到桌面（连续两次返回退出）。
2. **沉浸式全屏**：隐藏状态栏与导航栏（`WindowInsetsControllerCompat`），软键盘弹出时按 IME inset 收缩 WebView，
   页面里的 `100vh` 不会再把输入框顶出屏幕。
3. **导入 / 导出可用**：`AndroidApp` 桥把 `StreamSaver`、`<a download>`、`window.open(blob:)`、`DownloadListener`
   统一改成「分块写入 → 下载/EPhone/」，导入仍走系统文件选择器（`onShowFileChooser`）。

## 目录结构

```
android/
├─ app/
│  ├─ build.gradle                 # syncWebAssets 任务会把根目录网页打进 assets/www
│  └─ src/main/
│     ├─ AndroidManifest.xml
│     ├─ java/com/ephone/app/
│     │  ├─ MainActivity.java      # WebView 宿主、全屏、返回键、文件选择器
│     │  └─ NativeFileBridge.java  # window.AndroidApp 桥（分块写文件）
│     └─ res/                      # 主题、图标
└─ native/ephone-native.js         # 只在 APK 内加载的前端增强层
```

`index.html` 里通过 `if (window.AndroidApp || location.hostname === 'appassets.androidplatform.net') { document.write('<script src="native/ephone-native.js">…') }`
按需加载增强层，所以同一份网页在浏览器 / GitHub Pages 上行为完全不变（浏览器里两个条件都不成立，不会多请求任何文件）。

## 用 GitHub Actions 出签名 APK（推荐）

`.github/workflows/android-apk.yml` 会在 push 到 `main` / `master`、或手动 `Run workflow` 时：

1. 装 JDK 17 + Android SDK 34 + Gradle 8.7（Android SDK 用 runner 镜像自带的，缺 `sdkmanager` 时自动下载兜底）；
2. 从 secrets 还原签名文件（没有 secrets 时生成一个测试签名，保证 APK 可装）；
3. `gradle assembleRelease -PbuildNumber=<run_number>`，并用 `apksigner` 校验签名；
4. 把 `EPhone-<run_number>.apk` 上传为 artifact；
5. 同时覆盖更新 Release `apk-latest`，手机上直接点链接就能下载安装。

### 手机上下载安装

构建完成后打开 **<https://github.com/Suzi190/000--330/releases/tag/apk-latest>**，
下载 `EPhone.apk` 即可安装（文件名固定的那个就是最新一次构建，`EPhone-<run_number>.apk` 是同一次构建的存档）。
Artifact 里的包需要登录 GitHub 才能下载，用不上时忽略即可。

### 配置正式签名（可选，但建议）

本地生成 keystore（只需一次，注意备份，丢了就无法覆盖安装更新）：

```bash
keytool -genkeypair -v -keystore ephone-release.jks -storetype JKS \
  -alias ephone -keyalg RSA -keysize 2048 -validity 10000
base64 -w 0 ephone-release.jks     # Windows: certutil -encode ephone-release.jks out.txt
```

然后在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 说明 |
| --- | --- |
| `KEYSTORE_BASE64` | `ephone-release.jks` 的 base64 文本 |
| `KEYSTORE_PASSWORD` | keystore 密码 |
| `KEY_ALIAS` | 例如 `ephone` |
| `KEY_PASSWORD` | key 密码（一般与 keystore 相同） |

## 本地构建

需要 JDK 17 + Android SDK 34。GitHub Actions 里用 Gradle 命令直接构建，不需要 wrapper；
本地想要 `./gradlew` 的话，先执行一次 `gradle wrapper --gradle-version 8.7` 生成 wrapper jar。

```bash
# 在 android/ 目录下
gradle assembleRelease -PbuildNumber=1
# 有 keystore/keystore.properties：app/build/outputs/apk/release/app-release.apk（已签名）
# 没有 keystore：输出 app-release-unsigned.apk，需要自己 apksigner 签名后才能安装
```

或直接用 Android Studio 打开 `android/` 目录（会自动生成 `local.properties`）。

## 备注

- APK 内会主动注销 Service Worker 并清空 Cache Storage（`MainActivity` + `ephone-native.js` 双保险），
  避免旧缓存盖住新资源；浏览器端照旧使用 `sw.js`。
- 导出的文件固定落在系统「下载/EPhone/」目录（MediaStore，无需存储权限）。
- 修改 `APP_URL` / `APP_HOST` 可换成线上地址；目前用 `WebViewAssetLoader` 提供
  `https://appassets.androidplatform.net/assets/www/index.html`，origin 稳定，localStorage / IndexedDB 才能持久化。
