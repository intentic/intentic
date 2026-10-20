package dev.intentic.app.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * A cold start into a conversation: timeToInitialDisplay is the first frame, timeToFullDisplay the first frame with
 * rows, which the screen reports itself (reportFullyDrawn), the spike's start rule.
 */
@RunWith(Parameterized::class)
class StartupBenchmark(private val mode: CompilationMode) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun parameters() = modes()
    }

    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun conversation() = rule.measureRepeated(
        packageName = APP,
        metrics = listOf(StartupTimingMetric()),
        compilationMode = mode,
        startupMode = StartupMode.COLD,
        iterations = 10,
        setupBlock = { pressHome() },
    ) {
        startActivityAndWait(conversation())
        rows()
    }
}
