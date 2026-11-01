package com.v2ptools.android

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * mihomo 内核管理。
 *
 * 二进制来源（按优先级）：
 *  1. jniLibs 里的 libmihomo.so —— Android 会把 native 库解压到 nativeLibraryDir，
 *     该目录的文件带可执行位，可以直接 exec（不用再 chmod）
 *  2. assets/core/mihomo —— 兜底，复制到 filesDir 后 chmod 755
 *
 * 配置文件由 JS 侧（configgen.js）生成，这里只负责落盘与启停。
 */
object MihomoCore {

    private var process: Process? = null
    private var startedAt = 0L
    private var lastError = ""
    private var mixedPort = 0
    private var ctlPort = 0
    private var nodeCount = 0
    private var routeMode = "global"
    private var vpnMode = false

    fun dataDir(ctx: Context): File = File(ctx.filesDir, "core").apply { mkdirs() }

    fun configFile(ctx: Context): File = File(dataDir(ctx), "config.yaml")

    fun logFile(ctx: Context): File = File(dataDir(ctx), "core.log")

    /* ---------------- 二进制 ---------------- */

    fun resolveBinary(ctx: Context): File? {
        val fromLibs = File(ctx.applicationInfo.nativeLibraryDir, "libmihomo.so")
        if (fromLibs.exists()) {
            if (!fromLibs.canExecute()) fromLibs.setExecutable(true)
            return fromLibs
        }
        val cached = File(dataDir(ctx), "mihomo")
        if (cached.exists() && cached.length() > 0) {
            if (!cached.canExecute()) cached.setExecutable(true)
            return cached
        }
        // 从 assets 兜底解压
        return try {
            ctx.assets.open("core/mihomo").use { input ->
                FileOutputStream(cached).use { out -> input.copyTo(out) }
            }
            cached.setExecutable(true)
            cached
        } catch (e: Exception) {
            lastError = "未找到内核：请把 mihomo 安卓内核放到 app/src/main/jniLibs/arm64-v8a/libmihomo.so"
            null
        }
    }

    /* ---------------- 规则文件 ---------------- */

    /** 把随包规则复制到 dataDir/rules（mihomo 只允许相对 dataDir 的路径） */
    fun ensureRules(ctx: Context): Int {
        val dir = File(dataDir(ctx), "rules").apply { mkdirs() }
        var copied = 0
        val names = listOf("cn-domain.yaml", "cn-cidr.yaml", "gfw-domain.yaml")
        for (name in names) {
            val dst = File(dir, name)
            try {
                ctx.assets.open("rules/$name").use { input ->
                    // 大小一致就跳过，避免每次启动都写 2MB
                    if (dst.exists() && dst.length() == input.available().toLong()) return@use
                    FileOutputStream(dst).use { out -> input.copyTo(out) }
                    copied++
                }
            } catch (e: Exception) {
                // 缺规则文件不致命，只是对应分流模式不可用
            }
        }
        return copied
    }

    /* ---------------- 启停 ---------------- */

    @Synchronized
    fun start(
        ctx: Context,
        configYaml: String,
        mixedPortIn: Int,
        ctlPortIn: Int,
        routeModeIn: String,
        nodeCountIn: Int,
        vpn: Boolean
    ): JSONObject {
        stop()

        val bin = resolveBinary(ctx)
            ?: return err("找不到 mihomo 内核，请先执行 npm run fetch-core:android")

        ensureRules(ctx)
        val dir = dataDir(ctx)
        val cfg = configFile(ctx)
        cfg.writeText(configYaml, Charsets.UTF_8)

        mixedPort = mixedPortIn
        ctlPort = ctlPortIn
        routeMode = routeModeIn
        nodeCount = nodeCountIn
        vpnMode = vpn
        lastError = ""

        return try {
            val pb = ProcessBuilder(bin.absolutePath, "-d", dir.absolutePath, "-f", cfg.absolutePath)
            pb.directory(dir)
            pb.redirectErrorStream(true)
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile(ctx)))
            val p = pb.start()
            process = p
            startedAt = System.currentTimeMillis()

            // 等 external-controller 就绪
            val ok = waitReady(ctlPortIn, 15000)
            if (!ok) {
                val tail = logTail(ctx, 6)
                stop()
                return err("内核启动失败：$tail")
            }
            status(ctx).put("ok", true)
        } catch (e: Exception) {
            lastError = e.message ?: "启动异常"
            stop()
            err(lastError)
        }
    }

    private fun waitReady(port: Int, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (process?.isAlive != true) return false
            try {
                val conn = URL("http://127.0.0.1:$port/version").openConnection() as HttpURLConnection
                conn.connectTimeout = 800
                conn.readTimeout = 800
                conn.requestMethod = "GET"
                val code = conn.responseCode
                conn.disconnect()
                if (code == 200) return true
            } catch (e: Exception) {
                // 还没起来，继续等
            }
            Thread.sleep(150)
        }
        return false
    }

    @Synchronized
    fun stop() {
        val p = process
        process = null
        if (p != null) {
            try {
                p.destroy()
                if (!p.waitFor(1200, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    p.destroyForcibly()
                }
            } catch (e: Exception) {
                try { p.destroyForcibly() } catch (e2: Exception) {}
            }
        }
        startedAt = 0
    }

    /* ---------------- 状态 ---------------- */

    fun isRunning(): Boolean = process?.isAlive == true

    fun status(ctx: Context): JSONObject {
        val running = isRunning()
        val o = JSONObject()
        o.put("ok", true)
        o.put("running", running)
        o.put("pid", if (running) process?.pid() ?: 0L else 0L)
        o.put("mixedPort", mixedPort)
        o.put("ctlPort", ctlPort)
        o.put("routeMode", routeMode)
        o.put("nodeCount", nodeCount)
        o.put("vpn", vpnMode)
        o.put("startedAt", startedAt)
        o.put("uptime", if (running && startedAt > 0) (System.currentTimeMillis() - startedAt) / 1000 else 0)
        o.put("error", lastError)
        o.put("binaryFound", resolveBinary(ctx) != null)
        return o
    }

    fun logTail(ctx: Context, lines: Int): String {
        return try {
            val f = logFile(ctx)
            if (!f.exists()) return ""
            val all = f.readLines()
            all.takeLast(lines).joinToString(" | ")
        } catch (e: Exception) {
            ""
        }
    }

    private fun err(msg: String): JSONObject {
        lastError = msg
        return JSONObject().put("ok", false).put("error", msg)
    }
}
