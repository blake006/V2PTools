package com.v2ptools.android

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var store: Store
    private val pool = Executors.newFixedThreadPool(6)

    private var pendingImportCb: String? = null
    private var pendingVpn: JSONObject? = null

    private val importLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val cb = pendingImportCb
        pendingImportCb = null
        if (cb == null) return@registerForActivityResult
        if (uri == null) {
            reply(cb, JSONObject().put("ok", false).put("canceled", true))
            return@registerForActivityResult
        }
        pool.execute {
            val res = try {
                val text = contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                val name = queryName(uri)
                JSONObject().put("ok", true).put("name", name).put("text", text)
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "读取失败")
            }
            reply(cb, res)
        }
    }

    private val saveLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val cb = pendingSaveCb
        pendingSaveCb = null
        val content = pendingSaveContent ?: ""
        if (cb == null) return@registerForActivityResult
        if (uri == null) {
            reply(cb, JSONObject().put("ok", false).put("canceled", true))
            return@registerForActivityResult
        }
        pool.execute {
            val res = try {
                contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                JSONObject().put("ok", true).put("path", uri.toString())
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "写入失败")
            }
            reply(cb, res)
        }
    }

    private var pendingSaveCb: String? = null
    private var pendingSaveContent: String? = null

    private val vpnPermLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cfg = pendingVpn
        pendingVpn = null
        if (cfg == null) return@registerForActivityResult
        if (r.resultCode == Activity.RESULT_OK) {
            startVpnService(cfg)
        } else {
            replyToLastVpn(JSONObject().put("ok", false).put("error", "用户拒绝了 VPN 授权"))
        }
    }

    private var lastVpnCb: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        store = Store(this)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            loadWithOverviewMode = true
            useWideViewPort = true
            textZoom = 100
        }
        web.setBackgroundColor(0xFF0E1015.toInt())
        web.addJavascriptInterface(Bridge(), "Native")
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: android.webkit.WebResourceRequest): android.webkit.WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }
        }
        // WebView 默认不处理 alert/confirm，不接管的话 JS 里 confirm 永远返回 false
        web.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
                android.app.AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("好") { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
                android.app.AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result?.confirm() }
                    .setNegativeButton("取消") { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }
        }
        setContentView(web)
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
    }

    /* ---------------- 与 JS 通信 ---------------- */

    private fun reply(cbId: String, obj: JSONObject) {
        runOnUiThread {
            val quoted = JSONObject.quote(obj.toString())
            web.evaluateJavascript("window.__resolve('$cbId', $quoted)", null)
        }
    }

    private fun replyToLastVpn(obj: JSONObject) {
        val cb = lastVpnCb
        lastVpnCb = null
        if (cb != null) reply(cb, obj)
    }

    private fun queryName(uri: Uri): String {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && c.moveToFirst()) c.getString(idx) else "import.txt"
            } ?: "import.txt"
        } catch (e: Exception) {
            "import.txt"
        }
    }

    private fun startVpnService(cfg: JSONObject) {
        val i = Intent(this, ProxyService::class.java).apply {
            action = ProxyService.ACTION_START_VPN
            putExtra(ProxyService.EXTRA_CONFIG, cfg.optString("config"))
            putExtra(ProxyService.EXTRA_MIXED_PORT, cfg.optInt("mixedPort", 7890))
            putExtra(ProxyService.EXTRA_CTL_PORT, cfg.optInt("ctlPort", 9090))
            putExtra(ProxyService.EXTRA_ROUTE_MODE, cfg.optString("routeMode", "global"))
            putExtra(ProxyService.EXTRA_NODE_COUNT, cfg.optInt("nodeCount", 0))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
        replyToLastVpn(JSONObject().put("ok", true).put("started", true))
    }

    inner class Bridge {

        @JavascriptInterface
        fun invoke(method: String, argsJson: String, callbackId: String) {
            pool.execute {
                val out = try {
                    dispatch(method, JSONObject(argsJson.ifEmpty { "{}" }), callbackId)
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: "内部错误")
                }
                if (out != null) reply(callbackId, out)
            }
        }

        /** 返回 null 表示由异步回调自行回复（文件选择 / VPN 授权） */
        private fun dispatch(method: String, a: JSONObject, cb: String): JSONObject? {
            when (method) {
                "store.get" -> {
                    val v = store.get(a.optString("key"))
                    return JSONObject().put("ok", true).put("value", v ?: JSONObject.NULL)
                }
                "store.set" -> {
                    store.set(a.optString("key"), a.optString("value"))
                    return JSONObject().put("ok", true)
                }
                "core.start" -> {
                    val cfg = a.optString("config")
                    val mixed = a.optInt("mixedPort", 7890)
                    val ctl = a.optInt("ctlPort", 9090)
                    val mode = a.optString("routeMode", "global")
                    val n = a.optInt("nodeCount", 0)
                    // 存原文，供服务被系统重建时兜底；不能 quote，否则配置里会多一层引号
                    store.set(ProxyService.KEY_PENDING_CONFIG, cfg)
                    val i = Intent(this@MainActivity, ProxyService::class.java).apply {
                        action = ProxyService.ACTION_START_CORE
                        putExtra(ProxyService.EXTRA_CONFIG, cfg)
                        putExtra(ProxyService.EXTRA_MIXED_PORT, mixed)
                        putExtra(ProxyService.EXTRA_CTL_PORT, ctl)
                        putExtra(ProxyService.EXTRA_ROUTE_MODE, mode)
                        putExtra(ProxyService.EXTRA_NODE_COUNT, n)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
                    return JSONObject().put("ok", true)
                }
                "core.stop" -> {
                    val i = Intent(this@MainActivity, ProxyService::class.java).apply {
                        action = ProxyService.ACTION_STOP
                    }
                    startService(i)
                    MihomoCore.stop()
                    return JSONObject().put("ok", true)
                }
                "core.status" -> {
                    val svc = ProxyService.instance
                    return if (svc != null) svc.statusJson() else MihomoCore.status(this@MainActivity)
                }
                "probe" -> return Probe.probe(
                    a.optInt("port"),
                    jsonList(a, "urls"),
                    a.optInt("timeout", 6000),
                    a.optInt("samples", 2)
                )
                "speed" -> return Probe.speed(
                    a.optInt("port"),
                    a.optString("url"),
                    a.optLong("bytes", 5_000_000L),
                    a.optInt("timeout", 15000)
                )
                "exit" -> return Probe.exitInfo(a.optInt("port"), a.optInt("timeout", 8000))
                "sub.fetch" -> {
                    val url = a.optString("url")
                    if (url.isEmpty()) return JSONObject().put("ok", false).put("error", "订阅地址为空")
                    // 没显式给端口就自己判断：内核在跑就用它的 mixed 端口走代理
                    val port = if (a.has("port")) {
                        a.optInt("port", 0)
                    } else {
                        val st = ProxyService.instance?.statusJson() ?: MihomoCore.status(this@MainActivity)
                        if (st.optBoolean("running")) st.optInt("mixedPort", 0) else 0
                    }
                    return SubFetch.fetch(url, port, a.optInt("timeout", 25000))
                }
                "dnsbl" -> return Probe.dnsbl(a.optString("ip"), a.optInt("timeout", 6000))
                "vpn.start" -> {
                    if (!LibcoreBridge.available()) {
                        return JSONObject().put("ok", false)
                            .put("error", "未集成 libcore.aar，无法启用 VPN。请使用 Wi-Fi 代理模式。")
                    }
                    pendingVpn = a
                    lastVpnCb = cb
                    val prep = VpnService.prepare(this@MainActivity)
                    if (prep != null) {
                        runOnUiThread { vpnPermLauncher.launch(prep) }
                        return null
                    }
                    startVpnService(a)
                    return null
                }
                "vpn.stop" -> {
                    val i = Intent(this@MainActivity, ProxyService::class.java).apply {
                        action = ProxyService.ACTION_STOP
                    }
                    startService(i)
                    return JSONObject().put("ok", true)
                }
                "file.pick" -> {
                    pendingImportCb = cb
                    runOnUiThread {
                        importLauncher.launch(arrayOf("text/*", "application/json", "application/octet-stream", "*/*"))
                    }
                    return null
                }
                "file.save" -> {
                    pendingSaveCb = cb
                    pendingSaveContent = a.optString("content")
                    val name = a.optString("name", "v2ptools-export.txt")
                    runOnUiThread { saveLauncher.launch(name) }
                    return null
                }
                "open.url" -> {
                    val url = a.optString("url")
                    if (url.startsWith("http")) {
                        runOnUiThread {
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            } catch (e: Exception) {
                            }
                        }
                    }
                    return JSONObject().put("ok", true)
                }
                "open.wifi" -> {
                    runOnUiThread {
                        try {
                            startActivity(Intent(android.provider.Settings.ACTION_WIFI_SETTINGS))
                        } catch (e: Exception) {
                        }
                    }
                    return JSONObject().put("ok", true)
                }
                "copy" -> {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("v2ptools", a.optString("text")))
                    return JSONObject().put("ok", true)
                }
                "app.info" -> {
                    return JSONObject()
                        .put("ok", true)
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("sdk", Build.VERSION.SDK_INT)
                        .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
                        .put("vpnAvailable", LibcoreBridge.available())
                }
                else -> return JSONObject().put("ok", false).put("error", "未知方法 $method")
            }
            // 理论上走不到；保留以满足编译器的返回值检查
            @Suppress("UNREACHABLE_CODE")
            return JSONObject().put("ok", false).put("error", "unreachable")
        }

        private fun jsonList(a: JSONObject, key: String): List<String> {
            val arr = a.optJSONArray(key) ?: return emptyList()
            val out = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) out.add(arr.optString(i))
            return out.ifEmpty {
                listOf("http://cp.cloudflare.com/generate_204", "http://www.gstatic.com/generate_204")
            }
        }
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (current === this) current = null
        pool.shutdownNow()
        super.onDestroy()
    }

    companion object {
        @Volatile
        private var current: MainActivity? = null

        fun emitStatus(st: JSONObject) {
            val act = current ?: return
            act.runOnUiThread {
                act.web.evaluateJavascript("window.__onStatus && window.__onStatus(${JSONObject.quote(st.toString())})", null)
            }
        }
    }
}
