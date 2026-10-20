package dev.intentic.app

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import dev.intentic.app.conversation.ConversationActivity
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestOpenFixtureInner

/**
 * Debug builds only. The conversation screen over the spike's fixture (`_editor/android-native/fixture`), which the
 * core opens and streams itself (OpenFixture), so no sandbox or sign-in is needed. It takes the spike bench's extras
 * and says `SPIKE_READY` as the spike's arms do, so the bench can measure the real app as one more arm:
 * `adb shell am start -S -W -n dev.intentic.app/.PreviewConversation --ei rows 2000 --ez stream true`.
 */
class PreviewConversation : ConversationActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        if (!intent.hasExtra(EXTRA_AGENT)) intent.putExtra(EXTRA_AGENT, FIXTURE_AGENT)
        super.onCreate(savedInstanceState)
    }

    override fun open(agent: String) {
        val json = assets.open(FIXTURE).use { it.readBytes().decodeToString() }
        val stream = intent.getBooleanExtra("stream", false)
        val request = RequestOpenFixtureInner(
            agent = agent,
            json = json,
            rows = intent.getIntExtra("rows", 2000).toUInt(),
            streamMs = if (stream) intent.getIntExtra("streamMs", 10_000).toUInt() else 0u,
            streamDelayMs = intent.getIntExtra("streamDelayMs", 1_500).toUInt(),
        )
        Calls.send(Request.OpenFixture(request)) { outcome ->
            if (outcome is Outcome.Failed) Log.e(TAG, "the fixture did not open: ${outcome.content.message}")
        }
    }

    // The spike's start rule (_editor/android-native, ConversationActivity.reportWhenDrawn): process start to the first
    // frame with rows, read as the spike reads it, first thing after that frame.
    override fun rowsDrawn(count: Int) {
        super.rowsDrawn(count)
        Handler(Looper.getMainLooper()).postAtFrontOfQueue {
            Log.i(TAG, "SPIKE_READY arm=app rows=$count ms=${SystemClock.uptimeMillis() - Process.getStartUptimeMillis()}")
        }
    }

    private companion object {
        const val TAG = "Spike"
        const val FIXTURE = "soft-deletes.json"
        const val FIXTURE_AGENT = "fixture"
    }
}
