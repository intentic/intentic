package dev.intentic.device

import android.app.Application
import dev.intentic.device.platform.FirebaseSupport

class DeviceApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
        Graph.notifier.createChannels()
        FirebaseSupport.init(this)
        Distribution.start(this)
    }
}
