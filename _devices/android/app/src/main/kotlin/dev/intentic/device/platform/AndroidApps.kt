package dev.intentic.device.platform

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import dev.intentic.device.store.AccessRequest
import dev.intentic.device.store.AccessRequests
import dev.intentic.device.store.AppMode
import dev.intentic.device.tools.AccessAsk
import dev.intentic.device.tools.AppsPort
import dev.intentic.device.tools.InstalledApp
import dev.intentic.device.tools.Links
import dev.intentic.device.tools.ToolFailed

/** The phone's launchable apps, and the notifications that open them or ask for them. Needs the `<queries>` launcher intent in the manifest. */
class AndroidApps(
    private val context: Context,
    private val requests: AccessRequests,
    private val notifier: Notifier,
) : AppsPort {
    private val packages: PackageManager = context.packageManager

    override fun launchable(): List<InstalledApp> {
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val found = if (android.os.Build.VERSION.SDK_INT >= 33) {
            packages.queryIntentActivities(launcher, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            packages.queryIntentActivities(launcher, 0)
        }
        return found
            .map { InstalledApp(it.activityInfo.packageName, it.loadLabel(packages).toString()) }
            .filter { it.pkg != context.packageName }
            .distinctBy { it.pkg }
    }

    override fun find(pkg: String): InstalledApp? = launchable().firstOrNull { it.pkg == pkg }

    override fun askToOpen(app: InstalledApp) {
        val launch = packages.getLaunchIntentForPackage(app.pkg) ?: throw ToolFailed("${app.label} has nothing to launch.")
        notifier.askToOpen(app.label, launch)
    }

    override fun askToOpenLink(url: String) {
        val host = Links.hostOf(url) ?: throw ToolFailed("Only http and https links can be opened.")
        notifier.askToOpen(host, Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
    }

    override fun askAccess(app: InstalledApp, mode: AppMode, reason: String): AccessAsk {
        if (requests.deniedRecently(app.pkg, mode)) {
            return AccessAsk.DENIED_RECENTLY
        }
        val request = AccessRequest(app.pkg, app.label, mode, reason, System.currentTimeMillis())
        if (!requests.add(request)) {
            return if (requests.find(app.pkg, mode) != null) AccessAsk.ALREADY_WAITING else AccessAsk.TOO_MANY
        }
        notifier.askAccess(request)
        return AccessAsk.ASKED
    }
}
