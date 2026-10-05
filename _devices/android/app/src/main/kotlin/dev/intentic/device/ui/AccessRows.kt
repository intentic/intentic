package dev.intentic.device.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.LinearLayout
import androidx.core.app.NotificationManagerCompat
import dev.intentic.device.BuildConfig
import dev.intentic.device.platform.NoticeListener

/**
 * Rows of "Access on this phone" for what only Android's own settings can switch on: notification access here (both builds),
 * and the touch service in the `direct` build's own rows. Each shows on or off and opens the right settings screen.
 */
object AccessRows {
    /** Whether the person switched notification access on for this app, which is not the same moment Android connects it. */
    fun notificationAccessOn(activity: Activity): Boolean = NotificationManagerCompat.getEnabledListenerPackages(activity).contains(activity.packageName)

    fun notificationAccess(activity: Activity, ui: Ui, content: LinearLayout) {
        if (notificationAccessOn(activity)) {
            content.addView(ui.action("Notification access: on. Your agent can read your notifications, including codes and messages, when \"Read notifications\" is on for this phone's card in your sandbox.", "Change") { openNotificationAccess(activity) })
        } else {
            content.addView(ui.action("Notification access: off. Your agent cannot read your notifications.", "Switch on") { openNotificationAccess(activity) })
            restrictedSettings(activity, ui, content)
        }
    }

    private fun openNotificationAccess(activity: Activity) {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                        .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(activity, NoticeListener::class.java).flattenToString()),
                )
                return
            } catch (error: ActivityNotFoundException) {
                // Fall through to the list.
            }
        }
        activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    /**
     * For an app installed from outside the Play Store, Android 13 and later block the accessibility and notification-access
     * switches until the person allows restricted settings in App info. Said plainly, with the way there.
     */
    fun restrictedSettings(activity: Activity, ui: Ui, content: LinearLayout) {
        if (Build.VERSION.SDK_INT < 33 || BuildConfig.DISTRIBUTION != "direct") {
            return
        }
        content.addView(
            ui.action(
                "If Android says the setting is restricted: this app was installed from outside the Play Store, so Android 13 and later keep this switch off until you allow it. " +
                    "Open App info, tap the three dots at the top right, choose \"Allow restricted settings\", then come back and try again.",
                "App info",
            ) { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))) },
        )
    }
}
