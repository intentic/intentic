package dev.intentic.bridgebench

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.TextView
import java.util.Locale

/**
 * The cold start [FirstActivity] makes, then each operation timed on the main thread, where an app makes its calls:
 * [WARM_UP] calls, then [CALLS] timed ones, logged as `BENCH_CALL ... op=<op> nsPerCall=<ns>`, and `BENCH_DONE` last.
 * The `jni` mode also times `echo-checked`, the echo as `_editor/mobile-core`'s bridge reads its argument today.
 */
class CallsActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val run = Run(intent)
        val bridge = run.start()
        setContentView(TextView(this).apply { text = "calls: ${run.mode}" })
        // The slowest mode runs for half a minute: a screen timing out would move it off the foreground's cores.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Once the start has settled, one operation per message, so the main thread's looper runs between them.
        val ops = (if (run.mode == "jni") OPS + "echo-checked" else OPS).iterator()
        fun next() {
            if (isDestroyed) {
                return
            }
            if (!ops.hasNext()) {
                run.log("BENCH_DONE", "")
                return
            }
            val op = ops.next()
            time(bridge, op, WARM_UP)
            val ns = time(bridge, op, CALLS)
            run.log("BENCH_CALL", "op=$op nsPerCall=${String.format(Locale.ROOT, "%.1f", ns.toDouble() / CALLS)}")
            main.post(::next)
        }
        main.postDelayed({
            spin()
            next()
        }, SETTLE_MS)
    }

    private fun time(bridge: Bridge, op: String, calls: Int): Long {
        var size = 0L
        val start = System.nanoTime()
        when (op) {
            "noop" -> repeat(calls) { bridge.noop() }
            "echo" -> repeat(calls) { size += bridge.echo(REQUEST).length }
            "bytes" -> repeat(calls) { size += bridge.bytes(PAYLOAD).size }
            "echo-checked" -> repeat(calls) { size += Jni.echoChecked(REQUEST).length }
        }
        val ns = System.nanoTime() - start
        // Every answer is read, so no call can be skipped, and checked once the clock has stopped.
        check(size == if (op == "noop") 0L else calls.toLong() * PAYLOAD.size) { "$op answered short" }
        return ns
    }

    /**
     * Keeps the core busy for [SPIN_MS] without touching Rust, so its clock has risen to where the timed calls run: the
     * fastest mode's 100,000 no-ops take a few milliseconds, less than the governor takes to ramp up.
     */
    private fun spin() {
        val until = System.nanoTime() + SPIN_MS * 1_000_000
        var x = 1L
        while (System.nanoTime() < until) {
            repeat(1_000) { x = x * 6_364_136_223_846_793_005L + 1 }
        }
        spun = x
    }

    private var spun = 0L

    private companion object {
        val OPS = listOf("noop", "echo", "bytes")
        const val WARM_UP = 10_000
        const val CALLS = 100_000
        const val SETTLE_MS = 500L
        const val SPIN_MS = 300L
    }
}
