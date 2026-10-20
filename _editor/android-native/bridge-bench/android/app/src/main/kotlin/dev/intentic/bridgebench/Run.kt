package dev.intentic.bridgebench

import android.content.Intent
import android.os.Process
import android.os.SystemClock
import android.util.Log

const val TAG = "BridgeBench"

/** One launch the bench made: the `mode` extra, and the `run` extra it finds this launch's log lines by. */
class Run(intent: Intent) {
    val mode: String = intent.getStringExtra("mode") ?: "jni"
    private val id: String = intent.getStringExtra("run") ?: "-"

    fun log(event: String, fields: String) {
        Log.i(TAG, "$event mode=$mode run=$id $fields")
    }

    /**
     * Loads the library, makes the first call (an [Bridge.echo], the shape of the app's first request) and logs
     * `BENCH_FIRST`: process start to the library ready (`loadMs`), the load step alone (`libUs`) and the first call
     * (`firstCallUs`).
     */
    fun start(): Bridge {
        val before = System.nanoTime()
        val bridge = loadBridge(mode)
        val loaded = System.nanoTime()
        val loadMs = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
        val reply = bridge.echo(REQUEST)
        val called = System.nanoTime()
        check(reply == REQUEST) { "$mode echoed something else" }
        log("BENCH_FIRST", "loadMs=$loadMs libUs=${(loaded - before) / 1_000} firstCallUs=${(called - loaded) / 1_000}")
        return bridge
    }
}
