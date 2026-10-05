package dev.intentic.device.touch

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.os.PowerManager
import android.view.Display
import androidx.annotation.RequiresApi
import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.ScreenCapture
import dev.intentic.device.tools.ScreenPort
import dev.intentic.device.tools.Shot
import dev.intentic.device.tools.ToolFailed
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Screenshots through the bound touch service on Android 11 and later, which need no prompt (Android's consent dialog is for
 * screen sharing; an accessibility service the person switched on is already trusted with the screen). Otherwise the
 * person-approved screen-sharing session answers, and asks for one when there is none.
 */
class AccessibilityScreen(private val projection: ScreenPort) : ScreenPort {
    override fun capture(): Shot? {
        val service = TouchService.instance
        if (service != null && Build.VERSION.SDK_INT >= ScreenCapture.ACCESSIBILITY_SCREENSHOT_SDK) {
            return take(service)
        }
        return projection.capture()
    }

    override fun askToShare() = projection.askToShare()

    @RequiresApi(30)
    private fun take(service: AccessibilityService): Shot {
        val power = service.getSystemService(PowerManager::class.java)
        if (!power.isInteractive) {
            throw ToolFailed("The phone's screen is off, so there is nothing to show.")
        }
        var attempts = 0
        while (true) {
            attempts += 1
            val outcome = once(service)
            if (outcome.shot != null) {
                return outcome.shot
            }
            if (outcome.code == TOO_SOON && attempts < 3) {
                Thread.sleep(MIN_INTERVAL_MS)
                continue
            }
            throw ToolFailed(
                when (outcome.code) {
                    TOO_SOON -> "Android allows a screenshot about once a second; try again in a moment."
                    NO_ACCESS -> "Android says the touch service may not take screenshots. The person can switch it off and on again in Accessibility settings."
                    else -> "Android could not take the screenshot (code ${outcome.code})."
                },
            )
        }
    }

    private class Outcome(val shot: Shot?, val code: Int)

    @RequiresApi(30)
    private fun once(service: AccessibilityService): Outcome {
        val done = CountDownLatch(1)
        var result: AccessibilityService.ScreenshotResult? = null
        var code = 0
        service.takeScreenshot(
            Display.DEFAULT_DISPLAY,
            EXECUTOR,
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                    result = screenshot
                    done.countDown()
                }

                override fun onFailure(errorCode: Int) {
                    code = errorCode
                    done.countDown()
                }
            },
        )
        if (!done.await(WAIT_MS, TimeUnit.MILLISECONDS)) {
            throw ToolFailed("The phone did not answer the screenshot in time. Try again.")
        }
        val taken = result ?: return Outcome(null, code)
        val buffer = taken.hardwareBuffer
        try {
            val hardware = Bitmap.wrapHardwareBuffer(buffer, taken.colorSpace) ?: return Outcome(null, INTERNAL)
            val full = hardware.copy(Bitmap.Config.ARGB_8888, false)
            hardware.recycle()
            val shown = FrameMath.fit(full.width, full.height)
            val scaled = if (shown.width == full.width && shown.height == full.height) full else Bitmap.createScaledBitmap(full, shown.width, shown.height, true)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            val shot = Shot(out.toByteArray(), scaled.width, scaled.height, full.width, full.height)
            if (scaled !== full) scaled.recycle()
            full.recycle()
            return Outcome(shot, 0)
        } finally {
            buffer.close()
        }
    }

    private companion object {
        val EXECUTOR = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "intentic-screenshot").apply { isDaemon = true } }
        const val WAIT_MS = 6_000L
        const val MIN_INTERVAL_MS = 1_100L
        const val JPEG_QUALITY = 80

        // AccessibilityService.ERROR_TAKE_SCREENSHOT_*: 1 internal, 2 no accessibility access, 3 interval too short.
        const val INTERNAL = 1
        const val NO_ACCESS = 2
        const val TOO_SOON = 3
    }
}
