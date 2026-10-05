package dev.intentic.device.store

import dev.intentic.device.protocol.ToolAudit
import org.json.JSONException
import org.json.JSONObject
import java.io.File

/**
 * What the agent did on this phone, one JSON object per line in app storage: when, which tool, its arguments, how it
 * ended. The owner reads the last 100 in the app. Text the agent sent to be typed or written is cut to 40 characters,
 * so the log shows what happened without becoming a second copy of what was written.
 */
class ActivityLog(private val file: File, private val now: () -> Long = System::currentTimeMillis) : ToolAudit {
    data class Entry(val time: Long, val tool: String?, val args: String?, val text: String)

    @Synchronized
    override fun record(tool: String, args: JSONObject, outcome: String) {
        append(JSONObject().put("t", now()).put("tool", tool).put("args", redact(args)).put("outcome", outcome))
    }

    /** Something that happened to the link rather than a tool call: paired, paused, resumed. */
    @Synchronized
    fun event(text: String) {
        append(JSONObject().put("t", now()).put("event", text))
    }

    /** The newest [count] entries, newest first. */
    @Synchronized
    fun last(count: Int = SHOWN): List<Entry> {
        if (!file.exists()) {
            return emptyList()
        }
        val entries = ArrayList<Entry>()
        for (line in file.readLines(Charsets.UTF_8).asReversed()) {
            if (entries.size >= count) {
                break
            }
            val entry = parse(line) ?: continue
            entries += entry
        }
        return entries
    }

    @Synchronized
    fun clear() {
        file.delete()
    }

    private fun parse(line: String): Entry? =
        try {
            val json = JSONObject(line)
            val event = json.optString("event", "")
            if (event.isNotEmpty()) {
                Entry(json.optLong("t"), null, null, event)
            } else {
                Entry(json.optLong("t"), json.optString("tool"), json.optJSONObject("args")?.toString(), json.optString("outcome"))
            }
        } catch (ignored: JSONException) {
            null
        }

    private fun append(json: JSONObject) {
        file.parentFile?.mkdirs()
        file.appendText(json.toString() + "\n", Charsets.UTF_8)
        if (file.length() > MAX_BYTES) {
            val kept = file.readLines(Charsets.UTF_8).takeLast(KEPT_LINES)
            file.writeText(kept.joinToString("\n", postfix = "\n"), Charsets.UTF_8)
        }
    }

    companion object {
        const val SHOWN = 100
        private const val MAX_BYTES = 256 * 1024L
        private const val KEPT_LINES = 500
        private const val TYPED_CHARS = 40
        private const val OTHER_CHARS = 200
        private val TYPED_KEYS = setOf("text", "content")

        /** The arguments as the log keeps them: `text` and `content` cut to 40 characters, any other string to 200. */
        fun redact(args: JSONObject): JSONObject {
            val kept = JSONObject()
            val keys = args.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = args.get(key)
                kept.put(key, if (value is String) cut(value, if (key in TYPED_KEYS) TYPED_CHARS else OTHER_CHARS) else value)
            }
            return kept
        }

        private fun cut(value: String, limit: Int): String = if (value.length <= limit) value else value.take(limit) + "..."
    }
}
