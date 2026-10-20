package dev.intentic.app.core

import android.os.Handler
import android.os.Looper
import java.io.File

/**
 * The Rust core (`_editor/mobile-core`), bound by JNI name to `src/bridge/jni.rs`. Requests and events cross as JSON
 * in the shapes `Messages.kt` declares (generated from the Rust, never edited here); [send] and [observe] are the typed
 * way in and out, and the two `external` functions are what they ride on.
 */
object Core {
    init {
        System.loadLibrary("intentic_mobile")
    }

    // Decoded on the core's event thread, handed to observers on the main one.
    private val events = Events(Handler(Looper.getMainLooper())::post)

    /** Starts the core once per process; a second call finds the first and keeps it. Throws IllegalStateException. */
    @JvmStatic external fun start(dataDir: String, configJson: String, listener: Listener)

    /** The call's number, which its [Event.Reply] carries back. Throws IllegalStateException before [start]. */
    @JvmStatic external fun call(requestJson: String): Int

    /** How many rows the core holds for `agent`'s conversation (Event.Rows says when that changes). */
    @JvmStatic external fun rowCount(agent: String): Int

    /**
     * Row [index] of `agent`'s conversation, drawn by the core: its text goes in `out[0]`, and the answer is the row's
     * view kind followed by span quads `[start, end, kind, arg]` in UTF-16 offsets ([Spans]). Null when there is no
     * such row. A list calls this for every row it binds, so it crosses as a string and an int array, never JSON.
     */
    @JvmStatic external fun row(agent: String, index: Int, out: Array<String?>): IntArray?

    /** The card a row of view kind [Spans.VIEW_CARD] draws, as `CardRow` JSON (Messages.kt), or null for any other row. */
    @JvmStatic external fun card(agent: String, index: Int): String?

    /** The id of the page a row of view kind [Spans.VIEW_PAGE] shows, what `/agents/<agent>/pages/<id>` names; else null. */
    @JvmStatic external fun pageId(agent: String, index: Int): String?

    /** Called by the core, on its own thread, with one event as JSON. */
    fun interface Listener {
        fun onEvent(eventJson: String)
    }

    fun launch(dataDir: File, config: Config) = start(dataDir.path, Wire.encode(config), Listener(events::deliver))

    fun send(request: Request): Int = call(Wire.encode(request))

    /** Every event from now until the returned handle is closed, on the main thread. */
    fun observe(observer: (Event) -> Unit): AutoCloseable = events.observe(observer)

    /** Every event on the core's own event thread, before the main thread sees it (Events.observeEarly). */
    fun observeEarly(observer: (Event) -> Unit): AutoCloseable = events.observeEarly(observer)
}
