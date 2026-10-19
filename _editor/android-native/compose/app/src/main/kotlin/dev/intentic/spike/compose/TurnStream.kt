package dev.intentic.spike.compose

/**
 * The turn `_tools/perf/src/chat/stream.ts` streams under a long chat, as a state machine driven by the caller's
 * clock, ported from core/src/stream.rs: a prompt, then answers that grow by `chunk` characters every `everyMs`,
 * each followed by its tool calls (`toolMs` running, `gapMs` after), until the duration has passed. The screen
 * calls [tick] once a frame; a late frame catches up on every step it missed, as a timer would have run them.
 */
class TurnStream(private val spec: StreamSpec, nowMs: Long, durationMs: Long) {
    private sealed interface Phase {
        data object Prompt : Phase
        data class Writing(val row: Int, val at: Int) : Phase
        data class ToolRunning(val row: Int, val tool: Int) : Phase
        data class ToolGap(val row: Int, val tool: Int) : Phase
    }

    /** The prose as code points, what Rust's `chars()` counts a chunk in. */
    private val prose: IntArray = spec.prose.codePoints().toArray()
    private val deadline = nowMs + durationMs
    private var next = nowMs
    private var phase: Phase = Phase.Prompt

    var done = false
        private set

    /** Runs every step due by [nowMs], replacing or appending rows in [rows]. Returns whether the turn has ended. */
    fun tick(rows: MutableList<Row>, nowMs: Long): Boolean {
        while (!done && next <= nowMs) {
            when (val phase = phase) {
                Phase.Prompt -> {
                    rows += Row(rows.size, Role.User, PROMPT)
                    answer(rows)
                }
                is Phase.Writing -> when {
                    next >= deadline -> done = true
                    phase.at < prose.size -> {
                        val end = minOf(phase.at + spec.chunk, prose.size)
                        val row = rows[phase.row]
                        rows[phase.row] = row.copy(text = row.text + String(prose, phase.at, end - phase.at))
                        this.phase = Phase.Writing(phase.row, end)
                        next += spec.everyMs
                    }
                    spec.tools.isEmpty() -> answer(rows)
                    else -> startTool(rows, phase.row, 0)
                }
                is Phase.ToolRunning -> {
                    val row = rows[phase.row]
                    if (row.tools.isNotEmpty()) {
                        rows[phase.row] = row.copy(tools = row.tools.dropLast(1) + row.tools.last().copy(status = ToolStatus.Done))
                    }
                    this.phase = Phase.ToolGap(phase.row, phase.tool)
                    next += spec.gapMs
                }
                is Phase.ToolGap -> when {
                    phase.tool + 1 < spec.tools.size -> startTool(rows, phase.row, phase.tool + 1)
                    next >= deadline -> done = true
                    else -> answer(rows)
                }
            }
        }
        return done
    }

    private fun answer(rows: MutableList<Row>) {
        rows += Row(rows.size, Role.Assistant, "")
        phase = Phase.Writing(rows.size - 1, 0)
    }

    private fun startTool(rows: MutableList<Row>, row: Int, tool: Int) {
        val current = rows[row]
        rows[row] = current.copy(tools = current.tools + ToolCall(spec.tools[tool], TOOL_TARGET, ToolStatus.Running))
        phase = Phase.ToolRunning(row, tool)
        next += spec.toolMs
    }

    companion object {
        const val PROMPT = "Run the migration against a copy of the schema, then its tests."
        const val TOOL_TARGET = "api/src/users.ts"
    }
}
