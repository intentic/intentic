package dev.intentic.spike

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.Executors

/**
 * Arm C: arm A's screen ([ConversationActivity]) with the transcript drawn by Rust on the GPU instead of by
 * RecyclerView rows ([SurfaceTranscriptView]). The composer, insets and touch stay native views. The conversation
 * opens, and the fonts and the GPU are made ready, on other threads while the views are built.
 */
class SurfaceConversationActivity : Activity() {
    private var handle = 0L
    private lateinit var transcript: SurfaceTranscriptView
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val launch = Launch.from(intent)
        val look = Look(this)

        val opener = Executors.newFixedThreadPool(3)
        opener.execute { Core.warm() }
        val gpu = opener.submit { SurfaceCore.warm() }
        val opening = opener.submit<Long> {
            val fixture = assets.open(FIXTURE).use { it.readBytes().decodeToString() }
            Core.open(fixture, launch.rows)
        }
        opener.shutdown()

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        transcript = SurfaceTranscriptView(this, gpu)
        root.addView(transcript, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(composer(look), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        handle = opening.get()
        transcript.conversation = handle
        transcript.whenRowsDrawn {
            reportFullyDrawn()
            val ms = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
            Log.i(TAG, "SPIKE_READY arm=surface rows=${launch.rows} ms=$ms")
        }
        if (launch.stream) {
            main.postDelayed({
                transcript.stream(launch.streamMs) { rows -> Log.i(TAG, "SPIKE_STREAM_DONE arm=surface rows=$rows") }
            }, launch.streamDelayMs)
        }
    }

    /** The same composer as arm A's. */
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
                if (text.isNotEmpty() && handle != 0L) {
                    transcript.appended(Core.appendUser(handle, text))
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

    override fun onDestroy() {
        super.onDestroy()
        main.removeCallbacksAndMessages(null)
        if (::transcript.isInitialized) transcript.release()
        if (handle != 0L) Core.close(handle)
        handle = 0L
    }

    private companion object {
        const val TAG = "Spike"
        const val FIXTURE = "soft-deletes.json"
    }
}
