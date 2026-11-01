package com.v2ptools.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val ch = NotificationChannel(
            CHANNEL_CORE,
            getString(R.string.notif_channel_core),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notif_channel_core_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(ch)
    }

    companion object {
        const val CHANNEL_CORE = "v2p_core"
        lateinit var instance: App
            private set
    }
}
