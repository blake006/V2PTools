package com.v2ptools.android

/**
 * libcore 适配层（VPN 模式，可选依赖）
 *
 * Android 的全局代理只能通过 VpnService 建立 TUN，再把 TUN 的 fd 交给
 * 一个用户态网络栈处理。mihomo 作为**独立进程**时无法接收外部 fd
 * （配置里没有 fd 字段），所以必须用 gomobile 编出来的 libcore。
 *
 * 把 libcore.aar 放到 app/libs/ 后，Gradle 会自动引入；这里用反射调用，
 * 好处是**没有 AAR 也能正常编译**，只是 VPN 不可用。
 *
 * 注意：不同版本 libcore 的导出签名不一致，这里按候选列表逐个尝试。
 * 若都失败，lastError 会给出具体原因，可在 README 里对照调整。
 */
object LibcoreBridge {

    @Volatile
    var lastError: String = ""
        private set

    private var core: Any? = null
    private var startMethod: java.lang.reflect.Method? = null
    private var stopMethod: java.lang.reflect.Method? = null

    private val CLASS_CANDIDATES = listOf(
        "libcore.Libcore",
        "com.github.metacubex.libcore.Libcore",
        "io.nekohasekai.libcore.Libcore"
    )

    /** libcore 是否已集成 */
    fun available(): Boolean = resolve() != null

    private fun resolve(): Class<*>? {
        for (name in CLASS_CANDIDATES) {
            try {
                return Class.forName(name)
            } catch (e: ClassNotFoundException) {
                // 继续试下一个
            }
        }
        return null
    }

    /**
     * 启动 TUN
     * @param fd       VpnService.establish() 得到的 fd
     * @param home     工作目录（放 config.yaml、rules、缓存）
     * @param config   完整 mihomo 配置 YAML
     * @param ctlPort  external-controller 端口
     */
    @Synchronized
    fun startTun(fd: Int, home: String, config: String, ctlPort: Int): Boolean {
        lastError = ""
        val clazz = resolve()
        if (clazz == null) {
            lastError = "未找到 libcore 类（候选：${CLASS_CANDIDATES.joinToString()}）"
            return false
        }

        // 候选签名：按 libcore 常见版本从新到旧
        val candidates = listOf(
            // (参数类型列表, 参数值)
            arrayOf<Class<*>>(Integer.TYPE, String::class.java, String::class.java) to arrayOf<Any>(fd, home, config),
            arrayOf<Class<*>>(Integer.TYPE, String::class.java) to arrayOf<Any>(fd, config),
            arrayOf<Class<*>>(Integer.TYPE, String::class.java, String::class.java, Integer.TYPE) to arrayOf<Any>(fd, home, config, ctlPort)
        )

        for ((types, args) in candidates) {
            try {
                val m = clazz.getMethod("startTUN", *types)
                m.isAccessible = true
                val ret = m.invoke(null, *args)
                startMethod = m
                val ok = when (ret) {
                    is Boolean -> ret
                    is Int -> ret == 0
                    null -> true
                    else -> true
                }
                if (ok) {
                    // 记住 stop 方法
                    stopMethod = try {
                        clazz.getMethod("stopTUN").apply { isAccessible = true }
                    } catch (e: Exception) {
                        null
                    }
                    return true
                }
                lastError = "startTUN 返回失败：$ret"
            } catch (e: NoSuchMethodException) {
                continue
            } catch (e: Exception) {
                lastError = "调用 startTUN 异常：${e.cause?.message ?: e.message}"
            }
        }

        if (lastError.isEmpty()) {
            lastError = "libcore 未提供可用的 startTUN 签名，请核对版本（README 有说明）"
        }
        return false
    }

    @Synchronized
    fun stopTun() {
        val m = stopMethod ?: return
        try {
            m.invoke(null)
        } catch (e: Exception) {
            lastError = "stopTUN 异常：${e.message}"
        }
    }
}
