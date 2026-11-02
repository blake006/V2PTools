package com.v2ptools.android

import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.PowerManager
import org.json.JSONObject

/**
 * 前台服务：持有 mihomo 进程，保证切后台/锁屏不被系统回收。
 *
 * 同时继承 VpnService —— Android 要求 VPN 权限声明在带 BIND_VPN_SERVICE 的
 * Service 上。VPN 的实际转发由 LibcoreBridge 负责（可选依赖）。
 *
 * 没有 libcore 时：服务仍正常工作，只提供 mixed-port 代理；
 * 有 libcore 时：额外可以把 TUN 流量交给 mihomo，实现全局代理。
 */
class ProxyService : VpnService() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var tunFd: Int = -1

    override fun onCreate() {
        super.onCreate()
        instance = this
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "v2p:core").apply {
            setReferenceCounted(false)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START_CORE
        when (action) {
            ACTION_STOP -> {
                shutdown()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START_VPN -> startVpn(intent)
            else -> startCore(intent)
        }
        return START_STICKY
    }

    /* ---------------- 普通代理模式 ---------------- */

    /**
     * 取配置内容。
     *
     * 配置**不能**走 Intent extra：Binder 单次事务上限约 1MB，节点多时 YAML 轻松超过，
     * 会抛 TransactionTooLargeException 直接把 App 干掉（「点全面体检就闪退」就是这么来的）。
     * 现在约定传文件路径，路径字符串几十字节，服务重建时再从 Store 里取回路径。
     */
    private fun configFrom(intent: Intent?): String? {
        val path = intent?.getStringExtra(EXTRA_CONFIG_PATH)
            ?: Store(this).get(KEY_PENDING_CONFIG_PATH)
        if (!path.isNullOrEmpty()) {
            val text = try {
                java.io.File(path).readText(Charsets.UTF_8)
            } catch (e: Exception) {
                null
            }
            if (!text.isNullOrEmpty()) return text
        }
        // 兼容旧版本：直接塞在 extra / 存储里的配置
        val inline = intent?.getStringExtra(EXTRA_CONFIG)
        if (!inline.isNullOrEmpty()) return inline
        return Store(this).get(KEY_PENDING_CONFIG)
    }

    private fun startCore(intent: Intent?) {
        val cfg = configFrom(intent)
        if (cfg.isNullOrEmpty()) {
            stopSelf()
            return
        }
        // 只持久化路径（很小），服务被系统重建时还能找回配置
        intent?.getStringExtra(EXTRA_CONFIG_PATH)?.let { Store(this).set(KEY_PENDING_CONFIG_PATH, it) }
        val mixed = intent?.getIntExtra(EXTRA_MIXED_PORT, 7890) ?: 7890
        val ctl = intent?.getIntExtra(EXTRA_CTL_PORT, 9090) ?: 9090
        val mode = intent?.getStringExtra(EXTRA_ROUTE_MODE) ?: "global"
        val count = intent?.getIntExtra(EXTRA_NODE_COUNT, 0) ?: 0

        startForegroundCompat(getString(R.string.notif_running), "127.0.0.1:$mixed")

        val r = MihomoCore.start(this, cfg, mixed, ctl, mode, count, false)
        if (r.optBoolean("ok")) {
            acquireWake()
        } else {
            shutdown()
            stopSelf()
        }
        notifyState()
    }

    /* ---------------- VPN 模式 ---------------- */

    private fun startVpn(intent: Intent?) {
        val cfg = configFrom(intent) ?: return
        val mixed = intent?.getIntExtra(EXTRA_MIXED_PORT, 7890) ?: 7890
        val ctl = intent?.getIntExtra(EXTRA_CTL_PORT, 9090) ?: 9090
        val mode = intent?.getStringExtra(EXTRA_ROUTE_MODE) ?: "global"
        val count = intent?.getIntExtra(EXTRA_NODE_COUNT, 0) ?: 0

        if (!LibcoreBridge.available()) {
            lastVpnError = "未集成 libcore.aar，无法启用 VPN。请改用 Wi-Fi 代理模式，或按 README 集成 libcore。"
            notifyState()
            stopSelf()
            return
        }

        startForegroundCompat(getString(R.string.notif_vpn_running), "VPN 模式")

        val builder = Builder()
            .setSession("V2PTools")
            .setMtu(1500)
            .addAddress("172.19.0.1", 30)
            .addRoute("0.0.0.0", 0)
            .addDnsServer("172.19.0.2")
            .setBlocking(true)

        // 把自己排除掉，否则内核自己的出站流量会被绕回 TUN
        try {
            builder.addDisallowedApplication(packageName)
        } catch (e: Exception) {
        }

        val pfd = try {
            builder.establish()
        } catch (e: Exception) {
            null
        }
        if (pfd == null) {
            lastVpnError = "建立 TUN 失败（可能被其它 VPN 占用）"
            notifyState()
            stopSelf()
            return
        }

        tunFd = pfd.fd
        val ok = LibcoreBridge.startTun(tunFd, MihomoCore.dataDir(this).absolutePath, cfg, ctl)
        if (!ok) {
            lastVpnError = LibcoreBridge.lastError.ifEmpty { "libcore 启动失败" }
            try { pfd.close() } catch (e: Exception) {}
            notifyState()
            stopSelf()
            return
        }

        // VPN 模式下内核由 libcore 托管，这里只记录状态
        vpnRunning = true
        acquireWake()
        notifyState()
    }

    /* ---------------- 生命周期 ---------------- */

    private fun shutdown() {
        releaseWake()
        if (vpnRunning) {
            LibcoreBridge.stopTun()
            vpnRunning = false
        }
        if (tunFd >= 0) {
            try { android.os.ParcelFileDescriptor.adoptFd(tunFd).close() } catch (e: Exception) {}
            tunFd = -1
        }
        MihomoCore.stop()
        notifyState()
    }

    override fun onRevoke() {
        shutdown()
        stopSelf()
        super.onRevoke()
    }

    override fun onDestroy() {
        instance = null
        shutdown()
        super.onDestroy()
    }

    private fun startForegroundCompat(title: String, text: String) {
        val intent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            else PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, App.CHANNEL_CORE)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(pi)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(pi)
                .setOngoing(true)
                .build()
        }
        startForeground(NOTIF_ID, n)
    }

    private fun acquireWake() {
        try {
            wakeLock?.acquire(6 * 60 * 60 * 1000L)
        } catch (e: Exception) {
        }
    }

    private fun releaseWake() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (e: Exception) {
        }
    }

    private fun notifyState() {
        val st = statusJson()
        MainActivity.emitStatus(st)
    }

    fun statusJson(): JSONObject {
        val o = MihomoCore.status(this)
        o.put("vpnRunning", vpnRunning)
        o.put("vpnAvailable", LibcoreBridge.available())
        o.put("vpnError", lastVpnError)
        return o
    }

    companion object {
        const val ACTION_START_CORE = "com.v2ptools.android.START_CORE"
        const val ACTION_START_VPN = "com.v2ptools.android.START_VPN"
        const val ACTION_STOP = "com.v2ptools.android.STOP"

        const val EXTRA_CONFIG = "config"
        const val EXTRA_CONFIG_PATH = "configPath"
        const val EXTRA_MIXED_PORT = "mixedPort"
        const val EXTRA_CTL_PORT = "ctlPort"
        const val EXTRA_ROUTE_MODE = "routeMode"
        const val EXTRA_NODE_COUNT = "nodeCount"

        const val KEY_PENDING_CONFIG = "pendingConfig"
        const val KEY_PENDING_CONFIG_PATH = "pendingConfigPath"
        const val NOTIF_ID = 1001

        /** 配置落盘位置：避免大字符串走 Binder */
        fun pendingConfigFile(ctx: android.content.Context, name: String = "pending-config.yaml"): java.io.File {
            return java.io.File(ctx.filesDir, name)
        }

        @Volatile
        var instance: ProxyService? = null
            private set

        @Volatile
        var vpnRunning: Boolean = false

        @Volatile
        var lastVpnError: String = ""
    }
}
