package com.v2ptools.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

/**
 * 通过「某个本地监听端口」发请求，用来测单个节点的质量。
 *
 * 安卓端每个节点在 mihomo 里都有独立的 listener 端口（configgen 生成），
 * 所以这里只需要知道端口号，不需要切换 selector，可以并发跑。
 */
object Probe {

    private const val UA = "Mozilla/5.0 (Linux; Android 13) V2PTools"

    private fun open(url: String, proxyPort: Int, timeoutMs: Int): HttpURLConnection {
        val proxy = if (proxyPort > 0) {
            Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort))
        } else {
            Proxy.NO_PROXY
        }
        val conn = URL(url).openConnection(proxy) as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", UA)
        conn.setRequestProperty("Accept", "*/*")
        return conn
    }

    /** 单次延迟：从发起连接到拿到响应头 */
    fun latency(proxyPort: Int, url: String, timeoutMs: Int): Long {
        val t0 = System.nanoTime()
        val conn = open(url, proxyPort, timeoutMs)
        try {
            val code = conn.responseCode
            if (code >= 400) throw RuntimeException("HTTP $code")
            return (System.nanoTime() - t0) / 1_000_000
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 多次采样延迟，顺带算抖动（标准差）
     * @return { ok, ms, jitter, samples[], error }
     */
    fun probe(proxyPort: Int, urls: List<String>, timeoutMs: Int, samples: Int): JSONObject {
        val okSamples = ArrayList<Long>()
        var lastErr = ""
        val want = samples.coerceIn(1, 5)

        for (i in 0 until want) {
            val url = urls[i % urls.size]
            try {
                okSamples.add(latency(proxyPort, url, timeoutMs))
            } catch (e: Exception) {
                lastErr = e.message ?: "失败"
            }
        }

        val out = JSONObject()
        if (okSamples.isEmpty()) {
            out.put("ok", false)
            out.put("error", lastErr.ifEmpty { "全部采样失败" })
            return out
        }
        val avg = okSamples.average()
        val jitter = if (okSamples.size > 1) {
            val varSum = okSamples.sumOf { (it - avg) * (it - avg) }
            Math.sqrt(varSum / okSamples.size)
        } else 0.0

        out.put("ok", true)
        out.put("ms", avg.toLong())
        out.put("jitter", Math.round(jitter))
        out.put("samples", JSONArray(okSamples))
        return out
    }

    /**
     * 下载测速：读满指定字节或超时，返回 Mbps
     * @return { ok, mbps, bytes, ms, error }
     */
    fun speed(proxyPort: Int, url: String, bytes: Long, timeoutMs: Int): JSONObject {
        val out = JSONObject()
        val t0 = System.nanoTime()
        var total = 0L
        val conn = open(url, proxyPort, timeoutMs)
        try {
            conn.responseCode
            val buf = ByteArray(32 * 1024)
            conn.inputStream.use { input ->
                while (total < bytes) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    if ((System.nanoTime() - t0) / 1_000_000 > timeoutMs) break
                }
            }
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.message ?: "下载失败")
            out.put("bytes", total)
            conn.disconnect()
            return out
        } finally {
            conn.disconnect()
        }

        val ms = (System.nanoTime() - t0) / 1_000_000
        if (total <= 0 || ms <= 0) {
            out.put("ok", false)
            out.put("error", "未读到数据")
            return out
        }
        val mbps = (total * 8.0) / (ms / 1000.0) / 1_000_000.0
        out.put("ok", true)
        out.put("bytes", total)
        out.put("ms", ms)
        out.put("mbps", Math.round(mbps * 10) / 10.0)
        return out
    }

    /**
     * 出口 IP + 归属地（走被测节点的端口）
     * 用 ip-api.com 的免费接口，字段精简后返回
     */
    fun exitInfo(proxyPort: Int, timeoutMs: Int): JSONObject {
        val out = JSONObject()
        val url = "http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,isp,org,as,query"
        val conn = open(url, proxyPort, timeoutMs)
        try {
            val code = conn.responseCode
            if (code >= 400) {
                out.put("ok", false)
                out.put("error", "HTTP $code")
                return out
            }
            val body = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
            val j = JSONObject(body)
            if (j.optString("status") != "success") {
                out.put("ok", false)
                out.put("error", j.optString("message", "查询失败"))
                return out
            }
            out.put("ok", true)
            out.put("ip", j.optString("query"))
            out.put("country", j.optString("country"))
            out.put("countryCode", j.optString("countryCode"))
            out.put("region", j.optString("regionName"))
            out.put("city", j.optString("city"))
            out.put("isp", j.optString("isp"))
            out.put("asn", j.optString("as").split(" ").firstOrNull() ?: "")
            return out
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.message ?: "查询失败")
            return out
        } finally {
            conn.disconnect()
        }
    }

    /**
     * DNSBL 检查（走 DoH，直连，不经过被测节点）
     * 查 zen.spamhaus.org：返回 127.0.0.x 表示命中黑名单
     */
    fun dnsbl(ip: String, timeoutMs: Int): JSONObject {
        val out = JSONObject()
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip)) {
            out.put("ok", false)
            out.put("error", "IP 格式无效")
            return out
        }
        val reversed = ip.split(".").reversed().joinToString(".")
        val url = "https://dns.google/resolve?name=$reversed.zen.spamhaus.org&type=A"
        val conn = open(url, 0, timeoutMs)
        try {
            val body = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
            val j = JSONObject(body)
            val answers = j.optJSONArray("Answer")
            var listed = false
            var code = ""
            if (answers != null) {
                for (i in 0 until answers.length()) {
                    val data = answers.getJSONObject(i).optString("data")
                    if (data.startsWith("127.0.0.")) {
                        listed = true
                        code = data
                    }
                }
            }
            out.put("ok", true)
            out.put("listed", listed)
            out.put("code", code)
            return out
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.message ?: "DNSBL 查询失败")
            return out
        } finally {
            conn.disconnect()
        }
    }
}
