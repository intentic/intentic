package dev.intentic.spike.flutter

import android.os.Process
import android.os.SystemClock
import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Hands the launch extras to Dart and writes the lines the measuring harness waits for:
 * `adb shell am start -S -W -n dev.intentic.spike.flutter/.MainActivity --ei rows 2000 --ez stream true`.
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "launch" -> result.success(
                    mapOf(
                        "rows" to intent.getIntExtra("rows", 2000),
                        "stream" to intent.getBooleanExtra("stream", false),
                        "streamDelayMs" to intent.getIntExtra("streamDelayMs", 1500),
                        "streamMs" to intent.getIntExtra("streamMs", 10000),
                    ),
                )
                "ready" -> {
                    reportFullyDrawn()
                    val ms = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
                    Log.i(TAG, "SPIKE_READY arm=flutter rows=${call.arguments} ms=$ms")
                    result.success(null)
                }
                "streamDone" -> {
                    Log.i(TAG, "SPIKE_STREAM_DONE arm=flutter rows=${call.arguments}")
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private companion object {
        const val CHANNEL = "dev.intentic.spike/launch"
        const val TAG = "Spike"
    }
}
