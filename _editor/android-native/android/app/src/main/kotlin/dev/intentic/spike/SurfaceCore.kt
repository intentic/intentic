package dev.intentic.spike

import android.view.Surface

/**
 * Arm C's renderer in the Rust core (`core/src/surface`, the `surface` feature), bound by JNI name: the transcript of
 * a [Core] conversation drawn by the GPU onto a [Surface]. A renderer is a handle [attach] returns and [detach] frees,
 * always before the conversation is closed. Every call but [warm] belongs on the main thread.
 */
object SurfaceCore {
    init {
        System.loadLibrary("intentic_mobile_core")
    }

    /** Loads the fonts and opens the GPU (Vulkan) ahead of [attach], on a background thread. */
    @JvmStatic external fun warm()

    /** Draws [conversation] on [surface]; Vulkan if it can present there, GL ES otherwise. */
    @JvmStatic external fun attach(conversation: Long, surface: Surface, width: Int, height: Int, density: Float, fontScale: Float): Long

    /** The adapter, backend and swapchain format the renderer draws with. */
    @JvmStatic external fun describe(renderer: Long): String

    @JvmStatic external fun resize(renderer: Long, width: Int, height: Int)

    /** Row [index] changed or was added: it is laid out again before it is next drawn. */
    @JvmStatic external fun changed(renderer: Long, index: Int)

    /**
     * Draws a frame scrolled [scroll] pixels up from the bottom. [out] gets the offset used (clamped to the content,
     * moved by rows that grew below the viewport), the largest offset (an estimate until the top has been laid out),
     * 1 if the offset was clamped and 1 if nothing could be presented and another frame should try. Returns how many
     * rows the presented frame shows.
     */
    @JvmStatic external fun frame(renderer: Long, scroll: Float, out: FloatArray): Int

    @JvmStatic external fun detach(renderer: Long)

    const val OUT_SCROLL = 0
    const val OUT_MAX_SCROLL = 1
    const val OUT_CLAMPED = 2
    const val OUT_AGAIN = 3
    const val OUT_SIZE = 4
}
