package com.v2ptools.android

import java.lang.reflect.Proxy

/**
 * mihomo.aar（gomobile bind 产物）的反射桥。
 *
 * 为什么用反射而不是直接 import：
 * AAR 是 CI 用 Go + gomobile 编出来的（见 android/native/ 与 .github/workflows/android.yml），
 * 本地没有 AAR 时也要能编译 APK。反射让「有没有 AAR」变成运行期问题，
 * 而不是编译期失败——没 AAR 就是 VPN 不可用，其余功能照常。
 *
 * gomobile 的映射规则：
 *   Go func Start(config string, fd int) error  →  Mihomo.start(String, long) throws Exception
 *   Go type Protector interface{Protect(int) bool} →  mihomo.Protector 接口
 */
object MihomoAar {

    private val cls: Class<*>? = try {
        Class.forName("mihomo.Mihomo")
    } catch (t: Throwable) {
        null
    }

    /** AAR 是否已打包进 APK */
    fun available(): Boolean = cls != null

    fun setHomeDir(dir: String) {
        val c = cls ?: return
        try {
            c.getMethod("setHomeDir", String::class.java).invoke(null, dir)
        } catch (t: Throwable) {
            // 版本不匹配时忽略，Start 里会给出更具体的错误
        }
    }

    /**
     * 启动内核（VPN 模式）。
     * @param protect 传给内核的 socket 保护回调，内部应调用 VpnService.protect(fd)
     * @return null 表示成功，否则为错误信息
     */
    fun start(config: String, fd: Int, protect: (Int) -> Boolean): String? {
        val c = cls ?: return "未集成 mihomo.aar，无法启用 VPN"

        return try {
            val iface = Class.forName("mihomo.Protector")
            val proxy = Proxy.newProxyInstance(iface.classLoader, arrayOf(iface)) { _, method, args ->
                when (method.name) {
                    "protect" -> {
                        val v = (args?.getOrNull(0) as? Number)?.toInt() ?: -1
                        if (v >= 0) protect(v) else false
                    }
                    "toString" -> "V2PToolsProtector"
                    "hashCode" -> System.identityHashCode(this)
                    "equals" -> false
                    else -> null
                }
            }
            c.getMethod("setProtector", iface).invoke(null, proxy)
            // Go 的 int 在 Java 侧是 long
            c.getMethod("start", String::class.java, java.lang.Long.TYPE)
                .invoke(null, config, fd.toLong())
            null
        } catch (t: Throwable) {
            val cause = (t as? java.lang.reflect.InvocationTargetException)?.cause ?: t
            cause.message ?: cause.toString()
        }
    }

    fun stop() {
        val c = cls ?: return
        try {
            c.getMethod("stop").invoke(null)
        } catch (t: Throwable) {
        }
    }
}
