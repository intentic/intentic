package dev.intentic.device

import android.app.Activity
import android.app.Application
import android.provider.Settings
import android.content.Intent
import android.widget.LinearLayout
import dev.intentic.device.tools.ScreenPort
import dev.intentic.device.tools.Tool
import dev.intentic.device.tools.ToolDeps
import dev.intentic.device.touch.AccessibilityScreen
import dev.intentic.device.touch.ServiceSetting
import dev.intentic.device.touch.TouchRuntime
import dev.intentic.device.touch.TouchService
import dev.intentic.device.ui.AccessRows
import dev.intentic.device.ui.Ui
import dev.intentic.device.update.DirectUpdater

/**
 * What the `direct` build (downloaded from intentic.dev) adds to the common app: it updates itself, and it carries the
 * touch service behind ui_elements, ui_act and device, with screenshots that need no prompt. Google Play does not allow an
 * agent to drive other apps through an accessibility service, which is why the `play` build has none of this.
 */
object Distribution {
    val updates: Updates? get() = DirectUpdater

    /** The tool families this build answers beyond the common ones. */
    val features: List<String> = listOf("touch")

    fun start(app: Application) {
        DirectUpdater.init(app)
        DirectUpdater.scheduleDaily()
        DirectUpdater.check()
    }

    /** ui_elements, ui_act and device. They refuse until the person switches the touch service on in Android's settings. */
    fun tools(deps: ToolDeps): List<Tool> = TouchRuntime.tools(deps)

    /** The touch service is switched on and Android has bound it. */
    fun accessibilityBound(): Boolean = TouchService.instance != null

    /** Screenshots go through the touch service when it is bound (Android 11 and later), else through the screen-sharing session. */
    fun screen(projection: ScreenPort): ScreenPort = AccessibilityScreen(projection)

    /** The touch service's row in "Access on this phone". */
    fun accessRows(activity: Activity, ui: Ui, content: LinearLayout) {
        val enabled = ServiceSetting.enabled(
            Settings.Secure.getString(activity.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
            activity.packageName,
            TouchService::class.java.name,
        )
        val bound = accessibilityBound()
        val text = when {
            bound -> "Touch and type (accessibility service): on. Your agent can read the screen and tap, swipe and type in the apps you allowed, when \"Tap, swipe and type\" is on for this phone's card in your sandbox. Pause it from Quick Settings."
            enabled -> "Touch and type (accessibility service): switched on, waiting for Android to start it."
            else -> "Touch and type (accessibility service): off. Switch it on in Settings, then Accessibility, then Intentic Device."
        }
        content.addView(ui.action(text, if (bound || enabled) "Change" else "Switch on") { activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
        if (!bound && !enabled) {
            AccessRows.restrictedSettings(activity, ui, content)
        }
    }
}
