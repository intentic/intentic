package dev.intentic.device.touch

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.pm.PackageManager
import android.graphics.Path
import android.view.accessibility.AccessibilityNodeInfo
import dev.intentic.device.platform.ScreenMetrics
import dev.intentic.device.tools.FrameMath
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** [TouchPort] over the bound [TouchService]. Every call finds the service afresh: the person can switch it off between two of them. */
object AndroidTouch : TouchPort {
    private val service: TouchService? get() = TouchService.instance

    override fun bound(): Boolean = service != null

    override fun foreground(): Foreground? {
        val s = service ?: return null
        val pkg = s.rootInActiveWindow?.packageName?.toString() ?: return null
        return Foreground(pkg, labelOf(s.packageManager, pkg))
    }

    override fun root(): UiNode? = service?.rootInActiveWindow?.let(::NodeAdapter)

    override fun screenSize(): FrameMath.Size {
        val s = service ?: throw IllegalStateException("the touch service is off")
        return ScreenMetrics.size(s)
    }

    override fun focusedInput(): UiNode? = service?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let(::NodeAdapter)

    override fun touch(x: Int, y: Int, holdMs: Long): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        return dispatch(path, holdMs)
    }

    override fun swipe(fromX: Int, fromY: Int, toX: Int, toY: Int, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(fromX.toFloat(), fromY.toFloat())
            lineTo(toX.toFloat(), toY.toFloat())
        }
        return dispatch(path, durationMs)
    }

    override fun navigate(nav: Nav): Boolean {
        val action = when (nav) {
            Nav.BACK -> AccessibilityService.GLOBAL_ACTION_BACK
            Nav.HOME -> AccessibilityService.GLOBAL_ACTION_HOME
            Nav.RECENTS -> AccessibilityService.GLOBAL_ACTION_RECENTS
            Nav.NOTIFICATIONS -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
            Nav.QUICK_SETTINGS -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
        }
        return service?.performGlobalAction(action) ?: false
    }

    /** Puts one gesture on the screen and waits for Android to say it finished. */
    private fun dispatch(path: Path, durationMs: Long): Boolean {
        val s = service ?: return false
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1))).build()
        val done = CountDownLatch(1)
        var completed = false
        val accepted = s.dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription) {
                    completed = true
                    done.countDown()
                }

                override fun onCancelled(gestureDescription: GestureDescription) {
                    done.countDown()
                }
            },
            null,
        )
        if (!accepted) {
            return false
        }
        done.await(durationMs + GESTURE_GRACE_MS, TimeUnit.MILLISECONDS)
        return completed
    }

    // An app Android hides from this one (package visibility) is named by its package.
    private fun labelOf(packages: PackageManager, pkg: String): String =
        try {
            packages.getApplicationLabel(packages.getApplicationInfo(pkg, 0)).toString()
        } catch (error: PackageManager.NameNotFoundException) {
            pkg
        }

    private const val GESTURE_GRACE_MS = 3_000L
}
