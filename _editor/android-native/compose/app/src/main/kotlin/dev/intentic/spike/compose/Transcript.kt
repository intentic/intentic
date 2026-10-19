package dev.intentic.spike.compose

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// The conversation the spike draws: the web demo's `cnv_soft_deletes` (fixture/soft-deletes.json), inflated to any
// number of rows by the rule core/src/transcript.rs states, so every arm draws the same text.

enum class Role { User, Assistant, Notice }

enum class ToolStatus { Running, Done }

data class ToolCall(val name: String, val summary: String, val status: ToolStatus)

/** One row of the conversation. Rows are only ever appended, so [id] is also the row's position. */
data class Row(val id: Int, val role: Role, val text: String, val tools: List<ToolCall> = emptyList())

/** The streamed turn, as the fixture states it (`stream` in soft-deletes.json, from `_tools/perf/src/chat/stream.ts`). */
@Serializable
data class StreamSpec(
    val prose: String,
    val chunk: Int,
    val everyMs: Long,
    val tools: List<String>,
    val toolMs: Long,
    val gapMs: Long,
)

@Serializable
private data class FixtureTool(val name: String, val summary: String)

@Serializable
private data class FixtureRow(val role: String, val text: String, val tools: List<FixtureTool>)

@Serializable
class Fixture private constructor(
    private val addition: String,
    val stream: StreamSpec,
    private val rows: List<FixtureRow>,
) {
    /**
     * The fixture's rows copied until there are [count] of them; every assistant answer of an even copy gains the
     * fixture's `addition` (a list, a table and a TypeScript block) with `{index}` replaced by the copy.
     */
    fun inflate(count: Int): List<Row> {
        require(rows.isNotEmpty()) { "the fixture has no rows" }
        val out = ArrayList<Row>(count)
        var copy = 0
        while (out.size < count) {
            for (source in rows) {
                if (out.size == count) break
                val role = roleOf(source.role)
                val text = if (role == Role.Assistant && copy % 2 == 0) {
                    source.text + addition.replace("{index}", copy.toString())
                } else {
                    source.text
                }
                out += Row(out.size, role, text, source.tools.map { ToolCall(it.name, it.summary, ToolStatus.Done) })
            }
            copy++
        }
        return out
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String): Fixture = json.decodeFromString(serializer(), text)

        private fun roleOf(name: String): Role = when (name) {
            "user" -> Role.User
            "assistant" -> Role.Assistant
            else -> Role.Notice
        }
    }
}
