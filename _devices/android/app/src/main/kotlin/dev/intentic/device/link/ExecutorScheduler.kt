package dev.intentic.device.link

import android.os.SystemClock
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The link controller's one thread, and a clock that keeps counting while the phone sleeps. */
class ExecutorScheduler : Scheduler {
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "intentic-link").apply { isDaemon = true } }

    override fun now(): Long = SystemClock.elapsedRealtime()

    override fun post(task: () -> Unit) {
        executor.execute(guarded(task))
    }

    override fun postDelayed(delayMs: Long, task: () -> Unit): Timer {
        val future = executor.schedule(guarded(task), delayMs, TimeUnit.MILLISECONDS)
        return object : Timer {
            override fun cancel() {
                future.cancel(false)
            }
        }
    }

    // A task that throws must not end the one thread everything runs on: a scheduled executor drops all later work after one failure.
    private fun guarded(task: () -> Unit): Runnable = Runnable {
        try {
            task()
        } catch (error: Throwable) {
            Log.e("IntenticLink", "link task failed", error)
        }
    }
}
