package dev.intentic.device.update

import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.provider.Settings
import androidx.core.app.NotificationCompat
import dev.intentic.device.BuildConfig
import dev.intentic.device.Graph
import dev.intentic.device.R
import dev.intentic.device.Updates
import dev.intentic.device.link.OkHttpSockets
import dev.intentic.device.ui.MainActivity
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * The `direct` build's updater. It looks for a newer `intentic-device.json` on launch and daily, and only downloads when
 * the owner taps "Download and install". The APK must match the manifest's SHA-256 before it reaches Android's installer,
 * and the installer asks the owner to confirm; it also refuses an APK not signed with this app's own key, which is what
 * makes the update trustworthy (the digest only catches a corrupt download, since both come from the same place).
 */
object DirectUpdater : Updates {
    private const val CHANNEL = "updates"
    private const val NOTICE_ID = 3
    private const val JOB_ID = 7101
    private const val DAY_MS = 24 * 60 * 60_000L

    private lateinit var app: Application
    private val http by lazy { OkHttpSockets.client() }

    @Volatile
    private var release: Release? = null

    @Volatile
    private var line = "Not checked yet."

    @Volatile
    private var busy = false

    fun init(application: Application) {
        app = application
        (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
            NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Says when a newer Intentic Device is available. It never installs without you."
            },
        )
    }

    fun scheduleDaily() {
        val scheduler = app.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        if (scheduler.getPendingJob(JOB_ID) != null) {
            return
        }
        scheduler.schedule(
            JobInfo.Builder(JOB_ID, ComponentName(app, UpdateJobService::class.java))
                .setPeriodic(DAY_MS)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build(),
        )
    }

    override fun status(): String = line

    override fun availableLabel(): String? = release?.let { "Download and install ${it.version}" }

    override fun check() {
        if (busy) {
            return
        }
        busy = true
        line = "Checking..."
        Graph.changes.fire()
        Thread({
            try {
                checkNow(announce = false)
            } finally {
                busy = false
                Graph.changes.fire()
            }
        }, "intentic-update-check").start()
    }

    /** The daily job's check, on the job's own thread. Posts a notification when something newer is there. */
    fun checkNow(announce: Boolean) {
        try {
            val manifest = http.newCall(Request.Builder().url(UpdateManifest.URL).build()).execute().use { response ->
                if (!response.isSuccessful) {
                    line = "Could not check for updates (HTTP ${response.code})."
                    return
                }
                response.body.string()
            }
            val found = UpdateManifest.parse(manifest)
            if (found == null) {
                line = "The update information could not be read."
                return
            }
            if (UpdateManifest.isNewer(found.version, BuildConfig.VERSION_NAME)) {
                release = found
                line = "Version ${found.version} is available."
                if (announce) {
                    announce(found)
                }
            } else {
                release = null
                line = "Up to date."
            }
        } catch (error: java.io.IOException) {
            line = "Could not reach the update server."
        }
    }

    private fun announce(found: Release) {
        val tap = PendingIntent.getActivity(app, 0, Intent(app, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(
            NOTICE_ID,
            NotificationCompat.Builder(app, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle("Intentic Device ${found.version} is available")
                .setContentText("Open the app to download and install it.")
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build(),
        )
    }

    override fun install(activity: Activity) {
        val found = release ?: return
        if (busy) {
            return
        }
        if (!app.packageManager.canRequestPackageInstalls()) {
            line = "Allow this app to install updates in the settings that just opened, then try again."
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}")))
            Graph.changes.fire()
            return
        }
        busy = true
        line = "Downloading ${found.version}..."
        Graph.changes.fire()
        Thread({
            try {
                val apk = download(found)
                if (apk != null) {
                    line = "Waiting for you to confirm the install."
                    Graph.changes.fire()
                    commit(apk)
                }
            } catch (error: java.io.IOException) {
                line = "The update could not be downloaded or handed to Android: ${error.message}"
            } finally {
                busy = false
                Graph.changes.fire()
            }
        }, "intentic-update-install").start()
    }

    /** The APK, only when its SHA-256 is the one the manifest named. */
    private fun download(found: Release): File? {
        val directory = File(app.cacheDir, "update").also { it.mkdirs() }
        directory.listFiles()?.forEach { it.delete() }
        val file = File(directory, "intentic-device-${found.version}.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        http.newCall(Request.Builder().url(found.url).build()).execute().use { response ->
            if (!response.isSuccessful) {
                line = "The download failed (HTTP ${response.code})."
                return null
            }
            file.outputStream().use { out ->
                response.body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        digest.update(buffer, 0, read)
                        out.write(buffer, 0, read)
                    }
                }
            }
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (actual != found.sha256) {
            file.delete()
            line = "The download did not match its checksum, so it was not installed."
            return null
        }
        return file
    }

    private fun commit(apk: File) {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("intentic-device.apk", 0, apk.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            // Mutable, because the installer adds its status to the intent; explicit, because Android 14 refuses a mutable implicit one.
            val result = PendingIntent.getBroadcast(
                app, id, Intent(app, InstallReceiver::class.java).setPackage(app.packageName),
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            session.commit(result.intentSender)
        }
    }

    /** What the installer said, for the About screen. */
    fun installerSaid(message: String) {
        line = message
        Graph.changes.fire()
    }
}
