package com.v2ptools.android

import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * 订阅拉取。
 *
 * 为什么必须走原生：WebView 里的 fetch() 只能直连，而这类订阅站的域名基本都被 DNS
 * 污染（例如解析到 93.46.8.90），直连一定超时。这里复用内核的 mixed 端口做正向代理，
 * 代理不可用时再退回直连，并把每一步的失败原因带回去，避免只看到一句「拉取失败」。
 */
object SubFetch {

    private const val MAX_BYTES = 12 * 1024 * 1024
    private const val MAX_REDIRECTS = 5

    private val UAS = arrayOf(
        "clash-verge/v2.4.2",
        "ClashforWindows/0.20.39",
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    )

    private class Result(
        val ok: Boolean,
        val text: String?,
        val error: String?,
        val kind: String = "",
        val code: Int = 0
    )

    /**
     * @param proxyPort 内核 mixed 端口，<=0 表示直连
     * @return { ok, text, bytes, via, error, kind, code }
     *         kind: http / timeout / dns / tls / empty / redirect / other
     *         界面据此区分「链接失效」「服务端异常」「被墙超时」，不再只显示一句失败
     */
    fun fetch(url: String, proxyPort: Int, timeoutMs: Int = 25000): JSONObject {
        val errors = ArrayList<String>()
        var lastKind = ""
        var lastCode = 0
        val timeout = timeoutMs.coerceIn(5000, 60000)

        // 1) 内核在跑：先走代理，被墙的订阅站只有这条路能通
        if (proxyPort > 0) {
            val r = attempt(url, proxyPort, timeout, 0)
            if (r.ok) {
                return JSONObject()
                    .put("ok", true)
                    .put("text", r.text)
                    .put("bytes", r.text?.length ?: 0)
                    .put("via", "127.0.0.1:$proxyPort")
            }
            errors.add("代理 127.0.0.1:$proxyPort：${r.error}")
            lastKind = r.kind
            lastCode = r.code
        }

        // 2) 直连兜底，换 UA 再试（部分订阅站按 UA 返回不同格式）
        for (i in UAS.indices) {
            val r = attempt(url, 0, timeout, i)
            if (r.ok) {
                return JSONObject()
                    .put("ok", true)
                    .put("text", r.text)
                    .put("bytes", r.text?.length ?: 0)
                    .put("via", "直连")
            }
            errors.add("直连：${r.error}")
            if (lastKind.isEmpty()) {
                lastKind = r.kind
                lastCode = r.code
            }
            // 超时说明网络根本不通，换 UA 也没意义
            if (r.kind == "timeout") break
        }

        val hint = if (proxyPort > 0) {
            "已尝试代理与直连"
        } else {
            "当前未开启代理，仅尝试直连；请先开启代理再拉取"
        }
        return JSONObject()
            .put("ok", false)
            .put("error", errors.joinToString("；") + "（$hint）")
            .put("kind", lastKind)
            .put("code", lastCode)
    }

    private fun attempt(url: String, proxyPort: Int, timeoutMs: Int, uaIndex: Int): Result {
        var current = url
        var redirects = 0
        while (true) {
            val conn = try {
                open(current, proxyPort, timeoutMs, UAS[uaIndex % UAS.size])
            } catch (e: Exception) {
                return Result(false, null, describe(e), kindOf(e))
            }
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    conn.disconnect()
                    if (loc.isNullOrBlank()) return Result(false, null, "HTTP $code 但没有 Location", "http", code)
                    if (++redirects > MAX_REDIRECTS) return Result(false, null, "重定向次数过多", "redirect")
                    current = try {
                        URI(current).resolve(loc).toString()
                    } catch (e: Exception) {
                        return Result(false, null, "重定向地址无效", "redirect")
                    }
                    continue
                }
                if (code != 200) {
                    conn.disconnect()
                    return Result(false, null, "HTTP $code", "http", code)
                }
                val text = readLimited(conn.inputStream)?.let { decode(it) }
                conn.disconnect()
                if (text.isNullOrBlank()) return Result(false, null, "内容为空", "empty")
                return Result(true, text, null)
            } catch (e: Exception) {
                try {
                    conn.disconnect()
                } catch (ignored: Exception) {
                }
                return Result(false, null, describe(e), kindOf(e))
            }
        }
    }

    private fun kindOf(e: Throwable): String = when (e) {
        is SocketTimeoutException -> "timeout"
        is UnknownHostException -> "dns"
        is SSLException -> "tls"
        else -> "other"
    }

    private fun open(url: String, proxyPort: Int, timeoutMs: Int, ua: String): HttpURLConnection {
        val proxy = if (proxyPort > 0) {
            Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort))
        } else {
            Proxy.NO_PROXY
        }
        val conn = URL(url).openConnection(proxy) as HttpURLConnection
        conn.connectTimeout = timeoutMs.coerceAtMost(15000)
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = false // 自己跟，才能处理 http → https 的跳转
        conn.requestMethod = "GET"
        conn.setRequestProperty("User-Agent", ua)
        conn.setRequestProperty("Accept", "*/*")
        conn.setRequestProperty("Accept-Encoding", "identity")
        return conn
    }

    /** 读满上限就中断，避免被异常响应撑爆内存 */
    private fun readLimited(input: InputStream): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        input.use { ins ->
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > MAX_BYTES) return null
            }
        }
        return out.toByteArray()
    }

    /** UTF-8 优先，出现替换字符再试 GBK（国内不少订阅是 ANSI/GBK） */
    private fun decode(bytes: ByteArray): String {
        val utf8 = String(bytes, Charsets.UTF_8)
        if (!utf8.contains('\uFFFD')) return utf8
        return try {
            val gbk = String(bytes, charset("GBK"))
            val bad = { s: String -> s.count { it == '\uFFFD' } }
            if (bad(gbk) < bad(utf8)) gbk else utf8
        } catch (e: Exception) {
            utf8
        }
    }

    private fun describe(e: Throwable): String = when (e) {
        is SocketTimeoutException -> "超时"
        is UnknownHostException -> "域名解析失败"
        is SSLException -> "TLS 握手失败（${e.message ?: "证书或协议问题"}）"
        is IOException -> e.message ?: "网络错误"
        else -> e.message ?: e.javaClass.simpleName
    }
}
