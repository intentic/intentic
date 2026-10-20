package dev.intentic.app.benchmark

import android.os.SystemClock
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.uiautomator.Direction
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** A conversation's frames: flung through its rows, and with rows streaming in. */
@RunWith(Parameterized::class)
class ConversationBenchmark(private val mode: CompilationMode) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun parameters() = modes()
    }

    @get:Rule
    val rule = MacrobenchmarkRule()

    // No startup mode: a cold one kills the process after setupBlock, which is what opens the conversation here.
    @Test
    fun scroll() = rule.measureRepeated(
        packageName = APP,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = mode,
        iterations = 5,
        setupBlock = {
            startActivityAndWait(conversation())
            rows()
        },
    ) {
        val rows = rows()
        repeat(3) { rows.fling(Direction.UP); device.waitForIdle() }
        repeat(3) { rows.fling(Direction.DOWN); device.waitForIdle() }
    }

    @Test
    fun stream() = rule.measureRepeated(
        packageName = APP,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = mode,
        startupMode = StartupMode.COLD,
        iterations = 3,
        setupBlock = { pressHome() },
    ) {
        startActivityAndWait(conversation(stream = true))
        rows()
        // The fixture streams from 1.5 s after opening for 10 s.
        SystemClock.sleep(12_000)
    }
}
