# 保留 JS 桥接方法（当前 release 未开启混淆，此规则用于以后开启时）
-keepattributes JavascriptInterface
-keepclassmembers class com.ephone.app.NativeFileBridge {
    public *;
}
