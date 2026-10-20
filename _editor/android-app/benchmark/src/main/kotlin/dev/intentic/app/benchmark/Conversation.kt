package dev.intentic.app.benchmark

import android.content.Intent
import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.ExperimentalMacrobenchmarkApi
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until

/** The bench build's id, from the build (benchmark/build.gradle.kts). */
val APP: String = InstrumentationRegistry.getArguments().getString("targetAppId") ?: error("no targetAppId")

/**
 * Every benchmark twice: with only the JIT, as a sideloaded build first runs, and with the Baseline Profile. Before
 * Android 14, and without root, Macrobenchmark resets the app's compiled code between the two by reinstalling it; on a
 * phone where an install hangs (one whose package verifier stalls), `-e compilation ignore` leaves the app as it is and
 * runs each benchmark once, for the person running it to compile the app as they mean to measure it first.
 */
@OptIn(ExperimentalMacrobenchmarkApi::class)
fun modes(): List<Array<Any>> =
    if (InstrumentationRegistry.getArguments().getString("compilation") == "ignore") {
        listOf(arrayOf(CompilationMode.Ignore()))
    } else {
        listOf(arrayOf(CompilationMode.None()), arrayOf(CompilationMode.Partial(BaselineProfileMode.Require)))
    }

/**
 * The conversation screen over the spike's fixture (2000 rows), as the spike's bench opens it; [stream] has the core
 * stream rows into it after 1.5 s for 10 s, as the bench's stream scenario does.
 */
fun MacrobenchmarkScope.conversation(stream: Boolean = false): Intent =
    Intent().setClassName(packageName, "dev.intentic.app.PreviewConversation").putExtra("rows", 2000).putExtra("stream", stream)

/**
 * The conversation's list, once it has drawn rows: the tallest scrollable view on screen, since the composer's
 * multi-line field reads as scrollable too.
 */
fun MacrobenchmarkScope.rows(): UiObject2 {
    device.wait(Until.hasObject(By.scrollable(true)), 5_000)
    val list = device.findObjects(By.scrollable(true)).maxByOrNull { it.visibleBounds.height() } ?: error("the conversation drew no rows")
    return list.apply { setGestureMargin(device.displayWidth / 5) }
}
