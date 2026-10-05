package dev.intentic.device.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.app.NotificationCompat
import androidx.core.content.IntentCompat
import dev.intentic.device.R

/** Where Android's installer reports on an update session: it asks the owner to confirm, then succeeds or says why not. Not exported. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (error: RuntimeException) {
                    // The app is not on screen, so Android will not open its dialog: a notification the owner taps will.
                    offer(context, confirm)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            else -> DirectUpdater.installerSaid(
                "The installer did not install it (${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $status"}).",
            )
        }
    }

    private fun offer(context: Context, confirm: Intent) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel("updates", "App updates", NotificationManager.IMPORTANCE_LOW))
        val tap = PendingIntent.getActivity(context, 0, confirm, PendingIntent.FLAG_IMMUTABLE)
        manager.notify(
            3,
            NotificationCompat.Builder(context, "updates")
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle("Finish updating Intentic Device")
                .setContentText("Tap to confirm the install.")
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build(),
        )
    }
}
