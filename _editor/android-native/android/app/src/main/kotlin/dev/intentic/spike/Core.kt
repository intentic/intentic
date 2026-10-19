package dev.intentic.spike

/**
 * The Rust core (`_editor/android-native/core`), bound by JNI name. A conversation is a handle [open] returns and
 * [close] frees. [render] puts the row's text in `out[0]` and returns its spans as `[start, end, kind, arg]` quads in
 * UTF-16 offsets, the kinds being [Spans]' constants.
 */
object Core {
    init {
        System.loadLibrary("intentic_mobile_core")
    }

    const val ROLE_USER = 0
    const val ROLE_ASSISTANT = 1
    const val ROLE_NOTICE = 2

    /** Loads the highlighting grammars, which the first row with code would otherwise wait for. */
    @JvmStatic external fun warm()

    @JvmStatic external fun open(fixture: String, rows: Int): Long

    @JvmStatic external fun close(handle: Long)

    @JvmStatic external fun count(handle: Long): Int

    @JvmStatic external fun role(handle: Long, index: Int): Int

    @JvmStatic external fun render(handle: Long, index: Int, out: Array<String?>): IntArray

    @JvmStatic external fun appendUser(handle: Long, text: String): Int

    @JvmStatic external fun streamStart(handle: Long, nowMs: Long, durationMs: Long)

    @JvmStatic external fun streaming(handle: Long): Boolean

    /** The rows the streamed turn changed or added by [nowMs]; rows past the last [count] are new. */
    @JvmStatic external fun streamTick(handle: Long, nowMs: Long): IntArray
}
