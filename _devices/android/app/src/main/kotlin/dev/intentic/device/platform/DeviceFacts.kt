package dev.intentic.device.platform

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import dev.intentic.device.BuildConfig
import dev.intentic.device.Distribution
import dev.intentic.device.protocol.Battery
import dev.intentic.device.protocol.FactsJson
import dev.intentic.device.protocol.PhoneSnapshot
import dev.intentic.device.store.AppAllowList
import dev.intentic.device.store.FolderStore
import dev.intentic.device.store.Settings
import dev.intentic.device.tools.NoticeLog
import dev.intentic.device.tools.ScreenCapture
import org.json.JSONObject
import java.util.Locale

/** What this phone reports as PhoneFacts. */
class DeviceFacts(
    private val context: Context,
    private val settings: Settings,
    private val folders: FolderStore,
    private val allowList: AppAllowList,
    private val notices: NoticeLog,
) {
    fun json(): JSONObject = FactsJson.of(snapshot())

    fun snapshot(): PhoneSnapshot =
        PhoneSnapshot(
            device = deviceName(),
            androidRelease = Build.VERSION.RELEASE,
            sdk = Build.VERSION.SDK_INT,
            build = BuildConfig.DISTRIBUTION,
            paused = settings.paused,
            // True only while the person has the touch service switched on and Android has bound it; the play build has none.
            accessibility = Distribution.accessibilityBound(),
            // True only while notification access is switched on and Android has connected the listener.
            notifications = notices.connected,
            screenCapture = ScreenCapture.mode(Distribution.accessibilityBound(), Build.VERSION.SDK_INT),
            folders = folders.all(),
            apps = allowList.all(),
            battery = battery(),
            fcmToken = if (FirebaseSupport.configured) settings.fcmToken else null,
            features = listOf("screenshot", "files", "apps", "clipboard", "notifications") + Distribution.features,
        )

    /** "Google Pixel 8": the maker and the model, without saying the maker twice. */
    private fun deviceName(): String {
        val maker = Build.MANUFACTURER.orEmpty().trim()
        val model = Build.MODEL.orEmpty().trim()
        return when {
            model.isEmpty() -> maker.ifEmpty { "Android phone" }
            maker.isEmpty() || model.startsWith(maker, ignoreCase = true) -> model
            else -> maker.replaceFirstChar { it.titlecase(Locale.ROOT) } + " " + model
        }
    }

    private fun battery(): Battery? {
        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = sticky.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) {
            return null
        }
        val status = sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return Battery(level * 100 / scale, status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
    }
}
