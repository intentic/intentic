package dev.intentic.spike

import android.content.Intent

/**
 * What a measured launch asks for, as intent extras, the same set every arm reads:
 * `adb shell am start -S -W -n dev.intentic.spike/.ConversationActivity --ei rows 2000 --ez stream true`.
 */
data class Launch(val rows: Int, val stream: Boolean, val streamDelayMs: Long, val streamMs: Long) {
    companion object {
        fun from(intent: Intent): Launch = Launch(
            rows = intent.getIntExtra("rows", 2000),
            stream = intent.getBooleanExtra("stream", false),
            streamDelayMs = intent.getIntExtra("streamDelayMs", 1500).toLong(),
            streamMs = intent.getIntExtra("streamMs", 10_000).toLong(),
        )
    }
}
