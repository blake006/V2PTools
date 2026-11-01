package com.v2ptools.android

import android.content.Context
import org.json.JSONObject

/**
 * 极简 KV 存储：值统一按 JSON 字符串存，读取时原样返回给 JS。
 * 桌面端用文件 + JSON，这里用 SharedPreferences，语义一致（key -> 任意 JSON）。
 */
class Store(context: Context) {

    private val sp = context.getSharedPreferences("v2p_store", Context.MODE_PRIVATE)

    fun get(key: String): String? = sp.getString(key, null)

    fun set(key: String, rawJson: String) {
        sp.edit().putString(key, rawJson).apply()
    }

    fun remove(key: String) {
        sp.edit().remove(key).apply()
    }

    /** 读取并解析，失败返回 fallback */
    fun getJson(key: String, fallback: JSONObject): JSONObject {
        val raw = get(key) ?: return fallback
        return try {
            JSONObject(raw)
        } catch (e: Exception) {
            fallback
        }
    }
}
