package dev.intentic.device.platform

import android.app.Notification
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import dev.intentic.device.Graph
import dev.intentic.device.tools.NoticeRecord

/**
 * Notification access, which the person switches on in Android's settings. While it is connected this records what other
 * apps post (never this app's own) into the notice log, which the `notifications` tool reads when its switch is on. It
 * does nothing else: it never dismisses, replies to or acts on a notification.
 */
class NoticeListener : NotificationListenerService() {
    override fun onListenerConnected() {
        val showing = try {
            activeNotifications?.map(::record).orEmpty()
        } catch (error: RuntimeException) {
            Log.w(TAG, "could not read the notifications showing", error)
            emptyList()
        }
        Graph.notices.connect(showing)
        Graph.changes.fire()
    }

    override fun onListenerDisconnected() {
        Graph.notices.disconnect()
        Graph.changes.fire()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        Graph.notices.posted(record(sbn))
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        Graph.notices.removed(sbn.key)
    }

    private fun record(sbn: StatusBarNotification): NoticeRecord {
        val notification = sbn.notification
        val extras = notification.extras
        val title = (extras?.getCharSequence(Notification.EXTRA_TITLE_BIG) ?: extras?.getCharSequence(Notification.EXTRA_TITLE))?.toString().orEmpty()
        val text = (extras?.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras?.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        return NoticeRecord(sbn.key, sbn.packageName, labelOf(sbn.packageName), title, text, sbn.postTime, notification.category)
    }

    // An app Android hides from this one (package visibility) is named by its package.
    private fun labelOf(pkg: String): String =
        try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (error: PackageManager.NameNotFoundException) {
            pkg
        }

    private companion object {
        const val TAG = "IntenticNotices"
    }
}
