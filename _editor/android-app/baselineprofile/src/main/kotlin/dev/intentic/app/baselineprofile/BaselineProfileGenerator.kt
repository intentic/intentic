package dev.intentic.app.baselineprofile

import android.content.Intent
import android.os.SystemClock
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What the profile is recorded on: a cold start to the sign-in screen (what the launcher opens with nobody signed in),
 * the conversation over the spike's fixture opened cold and scrolled, the same conversation streaming, and the board.
 * The conversation and the board come from the preview screens (src/preview), which need no account; the classes they
 * run are the app's own, and the preview's are filtered out of the profile (app/build.gradle.kts).
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    private val app = InstrumentationRegistry.getArguments().getString("targetAppId")
        ?: error("no targetAppId: run this through :app:generateBaselineProfile")

    @Test
    fun generate() = rule.collect(packageName = app, includeInStartupProfile = true) {
        pressHome()
        startActivityAndWait()

        startActivityAndWait(preview("PreviewConversation"))
        scrollConversation()

        startActivityAndWait(preview("PreviewConversation").putExtra("stream", true).putExtra("streamDelayMs", 500).putExtra("streamMs", 6_000))
        SystemClock.sleep(7_000)

        startActivityAndWait(preview("PreviewBoard"))
        device.wait(Until.hasObject(By.scrollable(true)), 5_000)
    }

    private fun MacrobenchmarkScope.preview(screen: String) = Intent().setClassName(packageName, "dev.intentic.app.$screen")

    private fun MacrobenchmarkScope.scrollConversation() {
        // The tallest scrollable view: the composer's multi-line field reads as scrollable too.
        device.wait(Until.hasObject(By.scrollable(true)), 5_000)
        val rows = device.findObjects(By.scrollable(true)).maxByOrNull { it.visibleBounds.height() } ?: error("the conversation drew no rows")
        rows.setGestureMargin(device.displayWidth / 5)
        repeat(3) { rows.fling(Direction.UP); device.waitForIdle() }
        repeat(3) { rows.fling(Direction.DOWN); device.waitForIdle() }
    }
}
