package dev.intentic.spike

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import android.view.Choreographer
import android.view.Gravity
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.util.concurrent.Executors

/**
 * Arm A: a conversation as RecyclerView rows of pre-built text (see [Rows]), a composer under it, and optionally a
 * streamed turn. Views are made in code, not inflated from XML, while the core opens the conversation and lays out
 * the rows the first frame shows on other threads.
 */
class ConversationActivity : Activity() {
    private var handle = 0L
    private lateinit var rows: Rows
    private lateinit var adapter: TranscriptAdapter
    private lateinit var list: RecyclerView
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val launch = Launch.from(intent)
        val look = Look(this)
        val width = resources.displayMetrics.widthPixels - 2 * look.dp(TranscriptAdapter.SIDE)

        // Off the main thread from the first line: grammars on one thread, the conversation and its last rows on others.
        val opener = Executors.newFixedThreadPool(2)
        opener.execute { Core.warm() }
        val opening = opener.submit<Rows> {
            val fixture = assets.open(FIXTURE).use { it.readBytes().decodeToString() }
            handle = Core.open(fixture, launch.rows)
            Rows(handle, look, width).also { it.buildNow((launch.rows - FIRST_SCREEN).coerceAtLeast(0) until launch.rows) }
        }
        opener.shutdown()

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        list = RecyclerView(this).apply {
            layoutManager = LinearLayoutManager(context).apply { stackFromEnd = true }
            itemAnimator = null
            setHasFixedSize(true)
            setItemViewCacheSize(VIEW_CACHE)
        }
        root.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(composer(look), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        rows = opening.get()
        adapter = TranscriptAdapter(rows, look, launch.rows)
        list.adapter = adapter
        reportWhenDrawn(launch.rows)
        if (launch.stream) {
            main.postDelayed({ stream(launch.streamMs) }, launch.streamDelayMs)
        }
    }

    private fun composer(look: Look): LinearLayout {
        val pad = look.dp(8f)
        val field = EditText(this).apply {
            hint = "Message"
            setTextColor(look.content)
            setHintTextColor(look.muted)
            maxLines = 6
            inputType = EditorInfo.TYPE_CLASS_TEXT or EditorInfo.TYPE_TEXT_FLAG_MULTI_LINE or EditorInfo.TYPE_TEXT_FLAG_CAP_SENTENCES
            background = GradientDrawable().apply {
                setColor(look.card)
                cornerRadius = look.dp(20f).toFloat()
            }
            setPadding(look.dp(14f), pad, look.dp(14f), pad)
        }
        val send = Button(this).apply {
            text = "Send"
            setOnClickListener {
                val text = field.text.toString().trim()
                if (text.isNotEmpty()) {
                    val index = Core.appendUser(handle, text)
                    adapter.count = index + 1
                    adapter.notifyItemInserted(index)
                    list.scrollToPosition(index)
                    field.text.clear()
                }
            }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
            setPadding(pad, pad, pad, pad)
            addView(field, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(send, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    /** `reportFullyDrawn` and a log line once a frame with rows in it has been drawn: what the bench times a start by. */
    private fun reportWhenDrawn(count: Int) {
        val observer = list.viewTreeObserver
        val listener = object : ViewTreeObserver.OnDrawListener {
            var done = false

            override fun onDraw() {
                if (done || list.childCount == 0) return
                done = true
                main.postAtFrontOfQueue {
                    reportFullyDrawn()
                    val ms = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
                    Log.i(TAG, "SPIKE_READY arm=views rows=$count ms=$ms")
                    list.viewTreeObserver.removeOnDrawListener(this)
                }
            }
        }
        observer.addOnDrawListener(listener)
    }

    /**
     * Streams the turn: each frame asks the core what changed, rebuilds the changed rows in that same frame and inserts
     * the new ones. A streamed row is small, so building it here costs a millisecond or two; handing it to the layout
     * workers instead (background priority, so the little cores on a big.LITTLE phone) landed it two or three frames
     * late on a Galaxy S10, and the text moved at a third of the frame rate.
     */
    private fun stream(durationMs: Long) {
        Core.streamStart(handle, SystemClock.uptimeMillis(), durationMs)
        val choreographer = Choreographer.getInstance()
        val tick = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                Trace.beginSection("spike.stream.tick")
                val pinned = !list.canScrollVertically(1)
                val changed = Core.streamTick(handle, SystemClock.uptimeMillis())
                val known = adapter.count
                val now = Core.count(handle)
                for (index in changed) {
                    if (index < known) {
                        rows.changed(index)
                        rows.build(index)
                        adapter.notifyItemChanged(index, REBUILT)
                    }
                }
                if (now > known) {
                    adapter.count = now
                    adapter.notifyItemRangeInserted(known, now - known)
                }
                if (pinned && changed.isNotEmpty()) list.scrollToPosition(now - 1)
                Trace.endSection()
                if (Core.streaming(handle)) {
                    choreographer.postFrameCallback(this)
                } else {
                    Log.i(TAG, "SPIKE_STREAM_DONE arm=views rows=$now")
                }
            }
        }
        choreographer.postFrameCallback(tick)
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::rows.isInitialized) rows.close()
        if (handle != 0L) Core.close(handle)
        handle = 0L
    }

    private companion object {
        const val TAG = "Spike"
        const val FIXTURE = "soft-deletes.json"
        /** Rows laid out before the first frame: more than a phone's screen of the fixture shows. */
        const val FIRST_SCREEN = 16
        const val VIEW_CACHE = 12
        val REBUILT = Any()
    }
}
