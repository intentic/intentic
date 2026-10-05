package dev.intentic.device.platform

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.IntentCompat
import dev.intentic.device.Graph

/**
 * The foreground service (type `mediaProjection`) that keeps one approved screen-sharing session alive. Android 14 and
 * later require the service to be in the foreground before the approval is turned into a projection, so the consent
 * activity starts this with the dialog's result and the projection is made here.
 */
class ProjectionService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data = intent?.let { IntentCompat.getParcelableExtra(it, EXTRA_DATA, Intent::class.java) }
        val notification = Graph.notifier.screenSharing()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(Notifier.ID_SCREEN, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(Notifier.ID_SCREEN, notification)
        }
        if (data == null || Graph.settings.paused || !Graph.screen.start(resultCode, data)) {
            stopSelf()
            return START_NOT_STICKY
        }
        Graph.log.event("The owner approved screen sharing")
        Graph.changes.fire()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        // The service going (the owner swiped it away, Android reclaimed it) ends the session with it.
        Graph.screen.stop()
        Graph.changes.fire()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
    }
}
