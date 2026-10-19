package dev.intentic.spike

import android.content.Context
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import android.view.Choreographer
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.widget.OverScroller
import java.util.concurrent.Future
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Arm C's transcript: a [SurfaceView] the Rust core draws on with the GPU ([SurfaceCore]). This view keeps touch
 * (drags, and flings run by an [OverScroller]) and the frame clock: on each Choreographer frame that has something to
 * do it ticks the stream, tells the renderer which rows changed, and has it draw at the scroll offset, which counts
 * pixels up from the bottom so the newest row is in view at 0. Rust clamps the offset to the content and hands back
 * the one it used. Frames run only while dragging, flinging or streaming.
 */
class SurfaceTranscriptView(context: Context, private val gpuReady: Future<*>) :
    SurfaceView(context), SurfaceHolder.Callback2, Choreographer.FrameCallback {

    /** The [Core] conversation drawn; set once it is open, before the surface exists. */
    var conversation = 0L
    private var renderer = 0L
    private var scroll = 0f
    private var maxScroll = 0f
    private val out = FloatArray(SurfaceCore.OUT_SIZE)

    private val scroller = OverScroller(context)
    /** How far the renderer moved the offset during a fling (rows grew below the viewport): added to the scroller's. */
    private var flingShift = 0f
    private var velocity: VelocityTracker? = null
    private var downY = 0f
    private var lastY = 0f
    private var dragging = false
    private val touchSlop: Int
    private val minFling: Int
    private val maxFling: Int

    private var scheduled = false
    private var streaming = false
    private var firstRows: (() -> Unit)? = null
    private var streamDone: ((Int) -> Unit)? = null

    init {
        holder.addCallback(this)
        val configuration = ViewConfiguration.get(context)
        touchSlop = configuration.scaledTouchSlop
        minFling = configuration.scaledMinimumFlingVelocity
        maxFling = configuration.scaledMaximumFlingVelocity
    }

    /** Calls [callback] once, after the first presented frame that has rows on it. */
    fun whenRowsDrawn(callback: () -> Unit) {
        firstRows = callback
    }

    /** Streams the turn for [durationMs], calling [done] with the row count when it ends. */
    fun stream(durationMs: Long, done: (Int) -> Unit) {
        Core.streamStart(conversation, SystemClock.uptimeMillis(), durationMs)
        streamDone = done
        streaming = true
        schedule()
    }

    /** A row was appended at [index] (the composer's prompt): show the bottom. */
    fun appended(index: Int) {
        if (renderer != 0L) SurfaceCore.changed(renderer, index)
        scroller.forceFinished(true)
        scroll = 0f
        schedule()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {}

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        if (renderer == 0L) {
            gpuReady.get()
            val metrics = resources.displayMetrics
            renderer = SurfaceCore.attach(conversation, holder.surface, width, height, metrics.density, resources.configuration.fontScale)
            Log.i(TAG, "SPIKE_SURFACE renderer=${SurfaceCore.describe(renderer)}")
        } else {
            SurfaceCore.resize(renderer, width, height)
        }
        // Drawn now, not next frame: the window shows with the transcript in it rather than an empty hole.
        if (draw()) schedule()
    }

    override fun surfaceRedrawNeeded(holder: SurfaceHolder) {
        if (draw()) schedule()
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        release()
    }

    /** Frees the renderer; it must go before the conversation is closed. */
    fun release() {
        Choreographer.getInstance().removeFrameCallback(this)
        scheduled = false
        if (renderer != 0L) SurfaceCore.detach(renderer)
        renderer = 0L
    }

    private fun schedule() {
        if (!scheduled) {
            scheduled = true
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    override fun doFrame(frameTimeNanos: Long) {
        scheduled = false
        var again = false
        if (streaming) {
            val changed = Core.streamTick(conversation, SystemClock.uptimeMillis())
            if (renderer != 0L) {
                for (index in changed) SurfaceCore.changed(renderer, index)
            }
            if (Core.streaming(conversation)) {
                again = true
            } else {
                streaming = false
                streamDone?.invoke(Core.count(conversation))
            }
        }
        if (draw()) again = true
        if (again) schedule()
    }

    /** Draws a frame at the current offset; returns whether another frame is wanted. */
    private fun draw(): Boolean {
        if (renderer == 0L) return false
        val flinging = scroller.computeScrollOffset()
        if (flinging) scroll = scroller.currY + flingShift
        Trace.beginSection("spike.surface.frame")
        val drawn = try {
            SurfaceCore.frame(renderer, scroll, out)
        } finally {
            Trace.endSection()
        }
        val used = out[SurfaceCore.OUT_SCROLL]
        maxScroll = out[SurfaceCore.OUT_MAX_SCROLL]
        if (flinging) {
            if (out[SurfaceCore.OUT_CLAMPED] != 0f) scroller.forceFinished(true) else flingShift += used - scroll
        }
        scroll = used
        if (drawn > 0) {
            firstRows?.let {
                firstRows = null
                it()
            }
        }
        return (flinging && !scroller.isFinished) || out[SurfaceCore.OUT_AGAIN] != 0f
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val tracker = velocity ?: VelocityTracker.obtain().also { velocity = it }
        tracker.addMovement(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                scroller.forceFinished(true)
                downY = event.y
                lastY = event.y
                dragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                val y = event.y
                if (!dragging && abs(y - downY) > touchSlop) {
                    dragging = true
                    lastY = y
                    parent?.requestDisallowInterceptTouchEvent(true)
                }
                if (dragging) {
                    // A finger moving down shows older rows: the offset from the bottom grows.
                    scroll += y - lastY
                    lastY = y
                    schedule()
                }
            }
            MotionEvent.ACTION_UP -> {
                if (dragging) {
                    tracker.computeCurrentVelocity(1000, maxFling.toFloat())
                    val speed = tracker.yVelocity
                    if (abs(speed) > minFling) fling(speed)
                }
                endTouch()
            }
            MotionEvent.ACTION_CANCEL -> endTouch()
        }
        return true
    }

    /** Flings at [speed] pixels a second, positive towards older rows. */
    fun fling(speed: Float) {
        flingShift = 0f
        scroller.fling(0, scroll.roundToInt(), 0, speed.roundToInt(), 0, 0, 0, max(maxScroll, scroll).roundToInt())
        schedule()
    }

    private fun endTouch() {
        dragging = false
        velocity?.recycle()
        velocity = null
    }

    private companion object {
        const val TAG = "Spike"
    }
}
