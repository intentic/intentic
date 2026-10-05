package dev.intentic.device.tools

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * What an agent is shown of the screen and how a point it names finds its way back to a phone pixel. The same idea as
 * the desktop agent's frames (_devices/desktop-automation/src/frames.ts): the screen is captured at a size a model reads
 * whole, because past its limits a model API shrinks the image itself and every coordinate read off it lands short.
 * Stage 2's tap and swipe tools read their coordinates in the newest frame and map them with [toPhone].
 */
object FrameMath {
    /** The longest edge a screenshot may have. */
    const val MAX_EDGE = 1568

    /** Its area; about what a model reads whole. A 9:20 phone meets the edge first, a squarer tablet this. */
    const val MAX_PIXELS = 1_150_000

    data class Size(val width: Int, val height: Int)

    /** The size a [width] by [height] screen is shown at: shrunk to fit both limits, never enlarged. */
    fun fit(width: Int, height: Int, maxEdge: Int = MAX_EDGE, maxPixels: Int = MAX_PIXELS): Size {
        require(width > 0 && height > 0) { "a screen has a size" }
        val scale = min(1.0, min(maxEdge.toDouble() / max(width, height), sqrt(maxPixels.toDouble() / (width.toLong() * height))))
        return Size(max(1, floor(width * scale).toInt()), max(1, floor(height * scale).toInt()))
    }

    /** One screenshot the agent was shown: its image size and the phone's own pixel size at the moment of capture. */
    data class Frame(val id: Int, val width: Int, val height: Int, val phoneWidth: Int, val phoneHeight: Int)

    data class Point(val x: Int, val y: Int)

    /** An image pixel of [frame] as the phone pixel at its centre. Throws [ToolFailed] for a point outside the image. */
    fun toPhone(frame: Frame, x: Int, y: Int): Point {
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
            throw ToolFailed("($x, $y) is outside frame f${frame.id}, which is ${frame.width}x${frame.height}. Read the coordinates off the image.")
        }
        val scaleX = frame.phoneWidth.toDouble() / frame.width
        val scaleY = frame.phoneHeight.toDouble() / frame.height
        return Point(floor((x + 0.5) * scaleX).toInt(), floor((y + 0.5) * scaleY).toInt())
    }

    /** A rectangle in image pixels of a frame: [x], [y] from its top left corner. */
    data class Box(val x: Int, val y: Int, val width: Int, val height: Int)

    /** A phone rectangle as it falls in [frame]'s image, the inverse of [toPhone]; parts off the image are left off, not clipped. */
    fun toFrame(frame: Frame, left: Int, top: Int, right: Int, bottom: Int): Box {
        val scaleX = frame.width.toDouble() / frame.phoneWidth
        val scaleY = frame.height.toDouble() / frame.phoneHeight
        val x = Math.round(left * scaleX).toInt()
        val y = Math.round(top * scaleY).toInt()
        return Box(x, y, max(1, Math.round((right - left) * scaleX).toInt()), max(1, Math.round((bottom - top) * scaleY).toInt()))
    }

    /** The sentence that goes with the image. */
    fun caption(frame: Frame): String =
        "frame f${frame.id}, ${frame.width}x${frame.height} (phone pixels ${frame.phoneWidth}x${frame.phoneHeight})"
}

/**
 * The screenshots this process has shown, newest last, numbered from 1 so a frame id from before a restart cannot be
 * mistaken for one minted after it. A point is only ever read in the newest: one read off an older image describes a
 * screen that may have moved since, and acting on it is how a tap lands on whatever took that place.
 */
class FrameLog {
    private val frames = ArrayList<FrameMath.Frame>()
    private var counter = 0

    @Synchronized
    fun record(width: Int, height: Int, phoneWidth: Int, phoneHeight: Int): FrameMath.Frame {
        counter += 1
        val frame = FrameMath.Frame(counter, width, height, phoneWidth, phoneHeight)
        frames += frame
        while (frames.size > REMEMBERED) {
            frames.removeAt(0)
        }
        return frame
    }

    @Synchronized
    fun latest(): FrameMath.Frame? = frames.lastOrNull()

    /**
     * The frame a point is read in. [named] is the id the agent passed ("f3" or "3"), or null for the newest. A frame older
     * than the newest is refused rather than guessed at, naming the newest.
     */
    @Synchronized
    fun resolve(named: String?): FrameMath.Frame {
        val newest = frames.lastOrNull() ?: throw ToolFailed("There is no screenshot yet. Take one with screenshot, read the coordinates off it, and pass its id as `frame`.")
        if (named == null || named.isBlank()) {
            return newest
        }
        val id = parseId(named) ?: throw ToolFailed("\"$named\" is not a frame id; screenshots are named like f${newest.id}.")
        if (id == newest.id) {
            return newest
        }
        throw ToolFailed(
            if (frames.any { it.id == id }) "Frame f$id is out of date: the screen was captured again since (the newest is f${newest.id}). Read the coordinates off the newest one."
            else "There is no frame f$id on this phone; the newest is f${newest.id}.",
        )
    }

    private companion object {
        const val REMEMBERED = 16

        fun parseId(text: String): Int? = text.trim().removePrefix("f").removePrefix("F").toIntOrNull()
    }
}
