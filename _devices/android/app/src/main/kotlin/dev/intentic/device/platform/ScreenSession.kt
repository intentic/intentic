package dev.intentic.device.platform

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import dev.intentic.device.Graph
import dev.intentic.device.tools.FrameMath
import dev.intentic.device.tools.ScreenPort
import dev.intentic.device.tools.Shot
import dev.intentic.device.tools.ToolFailed
import java.io.ByteArrayOutputStream

/**
 * Screenshots through MediaProjection. Android makes the person approve screen sharing in a system dialog, once per
 * session (Android 14 also forbids reusing an approval), so a session is one projection kept alive by [ProjectionService]
 * with one virtual display mirroring the screen into an ImageReader at the size the agent is shown. The newest frame is
 * held, so a screenshot of a screen that has not changed since it was last drawn still has something to return.
 *
 * The session ends when the owner pauses, the link closes, the owner stops it from the notification or Android's own
 * indicator, or fifteen minutes pass without a screenshot.
 */
class ScreenSession(private val context: Context) : ScreenPort {
    private class Size(val width: Int, val height: Int) {
        override fun equals(other: Any?): Boolean = other is Size && other.width == width && other.height == height

        override fun hashCode(): Int = width * 31 + height
    }

    private val lock = Object()
    private var projection: MediaProjection? = null
    private var callback: MediaProjection.Callback? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var held: Image? = null
    private var screen: Size? = null

    @Volatile
    private var active = false

    fun isActive(): Boolean = active

    override fun askToShare() {
        Graph.notifier.askToShareScreen()
    }

    /** Begins a session from the result of Android's consent dialog. Called by [ProjectionService] once it is in the foreground. */
    fun start(resultCode: Int, data: Intent): Boolean {
        synchronized(lock) {
            endLocked()
            val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val granted = try {
                manager.getMediaProjection(resultCode, data)
            } catch (error: RuntimeException) {
                null
            } ?: return false
            val worker = HandlerThread("intentic-screen").also { it.start() }
            val workHandler = Handler(worker.looper)
            val ended = object : MediaProjection.Callback() {
                override fun onStop() {
                    Graph.log.event("Screen sharing ended")
                    stop()
                }
            }
            // Android 14 requires the callback before the first virtual display.
            granted.registerCallback(ended, workHandler)
            projection = granted
            callback = ended
            thread = worker
            handler = workHandler
            val size = phoneSize()
            screen = size
            buildDisplay(size)
            active = true
            scheduleIdleStop()
            return true
        }
    }

    override fun capture(): Shot? {
        synchronized(lock) {
            if (!active) {
                return null
            }
            val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!power.isInteractive) {
                throw ToolFailed("The phone's screen is off, so there is nothing to show.")
            }
            val now = phoneSize()
            if (now != screen) {
                rebuildDisplay(now)
            }
            val deadline = SystemClock.uptimeMillis() + FRAME_WAIT_MS
            while (held == null) {
                val left = deadline - SystemClock.uptimeMillis()
                if (left <= 0) {
                    throw ToolFailed("The phone sent no picture of the screen in time. Try again.")
                }
                lock.wait(left)
                if (!active) {
                    return null
                }
            }
            val frame = held!!
            val jpeg = encode(frame)
            scheduleIdleStop()
            return Shot(jpeg.bytes, jpeg.width, jpeg.height, now.width, now.height)
        }
    }

    /** Ends the session, whoever asked: the owner, the link closing, Android, or the idle timer. Safe to call twice. */
    fun stop() {
        val wasActive: Boolean
        synchronized(lock) {
            wasActive = projection != null
            endLocked()
        }
        if (wasActive) {
            context.stopService(Intent(context, ProjectionService::class.java))
        }
    }

    private fun endLocked() {
        active = false
        handler?.removeCallbacksAndMessages(null)
        held?.close()
        held = null
        display?.release()
        display = null
        reader?.close()
        reader = null
        projection?.let { p ->
            callback?.let { p.unregisterCallback(it) }
            p.stop()
        }
        projection = null
        callback = null
        thread?.quitSafely()
        thread = null
        handler = null
        screen = null
        lock.notifyAll()
    }

    private fun buildDisplay(size: Size) {
        val shown = FrameMath.fit(size.width, size.height)
        val images = ImageReader.newInstance(shown.width, shown.height, PixelFormat.RGBA_8888, 3)
        images.setOnImageAvailableListener({ onImage(it) }, handler)
        reader = images
        display = projection!!.createVirtualDisplay(
            "intentic-screen", shown.width, shown.height, context.resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, images.surface, null, handler,
        )
    }

    /** The screen turned: the same virtual display is resized and pointed at a new reader, since Android 14 allows one per approval. */
    private fun rebuildDisplay(size: Size) {
        val shown = FrameMath.fit(size.width, size.height)
        val old = reader
        held?.close()
        held = null
        val images = ImageReader.newInstance(shown.width, shown.height, PixelFormat.RGBA_8888, 3)
        images.setOnImageAvailableListener({ onImage(it) }, handler)
        reader = images
        display?.resize(shown.width, shown.height, context.resources.displayMetrics.densityDpi)
        display?.surface = images.surface
        old?.close()
        screen = size
    }

    private fun onImage(images: ImageReader) {
        val latest = try {
            images.acquireLatestImage()
        } catch (error: IllegalStateException) {
            null
        } ?: return
        synchronized(lock) {
            if (images !== reader) {
                latest.close()
                return
            }
            held?.close()
            held = latest
            lock.notifyAll()
        }
    }

    private class Encoded(val bytes: ByteArray, val width: Int, val height: Int)

    private fun encode(image: Image): Encoded {
        val plane = image.planes[0]
        val padding = plane.rowStride - plane.pixelStride * image.width
        val padded = Bitmap.createBitmap(image.width + padding / plane.pixelStride, image.height, Bitmap.Config.ARGB_8888)
        padded.copyPixelsFromBuffer(plane.buffer.duplicate().also { it.rewind() })
        val bitmap = if (padding == 0) padded else Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        val encoded = Encoded(out.toByteArray(), bitmap.width, bitmap.height)
        if (bitmap !== padded) bitmap.recycle()
        padded.recycle()
        return encoded
    }

    private fun scheduleIdleStop() {
        val work = handler ?: return
        work.removeCallbacksAndMessages(IDLE_TOKEN)
        work.postAtTime(
            {
                Graph.log.event("Screen sharing ended: no screenshot for 15 minutes")
                stop()
            },
            IDLE_TOKEN,
            SystemClock.uptimeMillis() + IDLE_MS,
        )
    }

    /** The screen's size in pixels as it is turned now. */
    private fun phoneSize(): Size {
        val size = ScreenMetrics.size(context)
        return Size(size.width, size.height)
    }

    private companion object {
        const val FRAME_WAIT_MS = 3_000L
        const val IDLE_MS = 15 * 60_000L
        const val JPEG_QUALITY = 80
        val IDLE_TOKEN = Any()
    }
}
