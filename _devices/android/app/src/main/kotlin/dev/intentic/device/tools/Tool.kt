package dev.intentic.device.tools

import dev.intentic.device.policy.Switch
import org.json.JSONArray
import org.json.JSONObject

/** What one call can do to the world, as MCP's tool annotations say it. */
enum class Effect { READ, WRITE, DESTRUCTIVE }

/** A refusal the owner's own settings caused (a folder picked read-only, an app not allowed). Reaches the agent as an error result. */
class ToolRefused(message: String) : Exception(message)

/** The tool could not do what was asked, for a reason the agent can act on (a missing file, a path that escapes its folder). */
class ToolFailed(message: String) : Exception(message)

/** One MCP tool result: a list of content blocks and whether the call failed. */
class ToolResult(val content: List<JSONObject>, val isError: Boolean = false, val outcome: String = if (isError) "error" else "ok") {
    fun toJson(): JSONObject = JSONObject().put("content", JSONArray(content)).put("isError", isError)

    companion object {
        fun text(text: String, isError: Boolean = false, outcome: String = if (isError) "error" else "ok"): ToolResult =
            ToolResult(listOf(textBlock(text)), isError, outcome)

        /** A call that was answered by asking the person on the phone, not by doing the thing. */
        fun asked(text: String): ToolResult = ToolResult(listOf(textBlock(text)), false, "asked the person on the phone")

        fun textBlock(text: String): JSONObject = JSONObject().put("type", "text").put("text", text)

        fun imageBlock(base64: String, mimeType: String): JSONObject =
            JSONObject().put("type", "image").put("data", base64).put("mimeType", mimeType)
    }
}

/**
 * One MCP tool the phone offers. `tools/list` advertises [inputSchema]; a call is checked against it before [call] runs.
 * Stage 2's accessibility and notification tools are further implementations, added through Distribution.tools().
 */
interface Tool {
    val name: String

    /** Written for the model reading it. */
    val description: String

    /** JSON Schema of the arguments. [Schema] reads the subset used here. */
    val inputSchema: JSONObject
    val effect: Effect

    /** The owner's switch this tool sits behind, or null when no switch decides it (describe, ask_access). */
    val needs: Switch?

    /** Throws [ToolRefused] or [ToolFailed] for a sentence the agent may read; anything else is reported as a failure. */
    fun call(args: JSONObject): ToolResult
}

/** `tools/list`'s annotations for an effect: both hints always spelled out, since an absent destructiveHint reads as true. */
fun Effect.annotations(): JSONObject = JSONObject().put("readOnlyHint", this == Effect.READ).put("destructiveHint", this == Effect.DESTRUCTIVE)

/** Builds the JSON Schema objects the tools advertise, so each tool's table stays short. */
object Schemas {
    fun obj(vararg properties: Pair<String, JSONObject>, required: List<String> = emptyList()): JSONObject {
        val props = JSONObject()
        for ((key, value) in properties) {
            props.put(key, value)
        }
        val schema = JSONObject().put("type", "object").put("properties", props)
        if (required.isNotEmpty()) {
            schema.put("required", JSONArray(required))
        }
        return schema.put("additionalProperties", false)
    }

    fun string(description: String): JSONObject = JSONObject().put("type", "string").put("description", description)

    fun integer(description: String, minimum: Int = 1): JSONObject =
        JSONObject().put("type", "integer").put("minimum", minimum).put("description", description)

    /** An `[x, y]` pair of whole numbers, as the desktop agent's tools spell a point. */
    fun point(description: String): JSONObject =
        JSONObject().put("type", "array").put("items", JSONObject().put("type", "integer")).put("minItems", 2).put("maxItems", 2).put("description", description)

    fun choice(description: String, vararg values: String): JSONObject =
        JSONObject().put("type", "string").put("enum", JSONArray(values.toList())).put("description", description)
}
