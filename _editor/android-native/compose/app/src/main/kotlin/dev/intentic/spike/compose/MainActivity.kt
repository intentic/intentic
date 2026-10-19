package dev.intentic.spike.compose

import android.graphics.Color
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.toMutableStateList

/**
 * Arm D: the conversation as a Compose LazyColumn of Markdown composables, written the way a typical Compose team
 * would write it. Reads the launch extras and the fixture, then hands the rows to [ConversationScreen].
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        val launch = Launch.from(intent)
        val fixture = Fixture.parse(assets.open(FIXTURE).use { it.readBytes().decodeToString() })
        val rows = fixture.inflate(launch.rows).toMutableStateList()

        // ReportDrawnWhen (ConversationScreen) decides the frame; this hears the reportFullyDrawn it led to.
        fullyDrawnReporter.addOnReportDrawnListener {
            val ms = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
            Log.i(TAG, "SPIKE_READY arm=compose rows=${rows.size} ms=$ms")
        }

        setContent {
            SpikeTheme {
                ConversationScreen(rows, fixture.stream, launch) { count ->
                    Log.i(TAG, "SPIKE_STREAM_DONE arm=compose rows=$count")
                }
            }
        }
    }

    private companion object {
        const val TAG = "Spike"
        const val FIXTURE = "soft-deletes.json"
    }
}
