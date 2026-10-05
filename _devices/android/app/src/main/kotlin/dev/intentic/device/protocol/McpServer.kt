package dev.intentic.device.protocol

import dev.intentic.device.policy.Gate
import dev.intentic.device.tools.Schema
import dev.intentic.device.tools.Tool
import dev.intentic.device.tools.ToolFailed
import dev.intentic.device.tools.ToolRefused
import dev.intentic.device.tools.ToolResult
import dev.intentic.device.tools.annotations
import org.json.JSONArray
import org.json.JSONObject

/** What the owner's activity log is told about one tool call. */
fun interface ToolAudit {
    fun record(tool: String, args: JSONObject, outcome: String)
}

/**
 * The MCP server this phone runs; the sandbox forwards JSON-RPC verbatim through the `mcp` method, so this table is the
 * whole surface (_shared/sandbox-contract/src/protocol/peer-mcp-server.ts is the shape it mirrors). A failed or refused
 * tool is a result with `isError`, never a JSON-RPC error.
 *
 * `initialize`, `ping` and `tools/list` answer whatever the switches or the pause say, and list every tool; only
 * `tools/call` goes through the [Gate].
 */
class McpServer(
    tools: List<Tool>,
    private val gate: Gate,
    private val audit: ToolAudit,
    private val serverVersion: String,
    /** Told of every `tools/call`, refused or not: the "On demand" linger counts it as the agent still being here. */
    private val onToolCall: () -> Unit = {},
) {
    private val byName = tools.associateBy { it.name }

    private val listing: JSONArray = JSONArray().also { array ->
        for (tool in tools) {
            array.put(
                JSONObject()
                    .put("name", tool.name)
                    .put("description", tool.description)
                    .put("inputSchema", tool.inputSchema)
                    .put("annotations", tool.effect.annotations()),
            )
        }
    }

    /** One MCP message in, its JSON-RPC response out; JSONObject.NULL for a notification, which has no response. */
    fun handle(message: Any?): Any {
        if (message !is JSONObject) {
            return JSONObject().put("jsonrpc", "2.0").put("id", JSONObject.NULL)
                .put("error", JSONObject().put("code", PhoneWire.Error.INVALID_REQUEST).put("message", "invalid request"))
        }
        if (!message.has("id")) {
            return JSONObject.NULL
        }
        val id = message.get("id")
        fun reply(result: JSONObject): JSONObject = JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result)
        return when (val method = message.opt("method")) {
            "initialize" -> reply(
                JSONObject()
                    .put("protocolVersion", PROTOCOL_VERSION)
                    .put("capabilities", JSONObject().put("tools", JSONObject()))
                    .put("serverInfo", JSONObject().put("name", SERVER_NAME).put("version", serverVersion)),
            )
            "ping" -> reply(JSONObject())
            "tools/list" -> reply(JSONObject().put("tools", listing))
            "tools/call" -> {
                val params = message.optJSONObject("params") ?: JSONObject()
                reply(callTool(params.optString("name", ""), params.optJSONObject("arguments") ?: JSONObject()).toJson())
            }
            else -> JSONObject().put("jsonrpc", "2.0").put("id", id)
                .put("error", JSONObject().put("code", PhoneWire.Error.METHOD_NOT_FOUND).put("message", "method \"$method\" is not supported"))
        }
    }

    private fun callTool(name: String, args: JSONObject): ToolResult {
        onToolCall()
        val tool = byName[name]
        val refusal = gate.refusal(tool)
        if (refusal != null) {
            audit.record(name, args, "refused: $refusal")
            return ToolResult.text(refusal, isError = true, outcome = "refused")
        }
        if (tool == null) {
            val unknown = "There is no tool \"$name\" on this phone. tools/list names the ones it has."
            audit.record(name, args, "error: no such tool")
            return ToolResult.text(unknown, isError = true)
        }
        val invalid = Schema.check(tool.inputSchema, args)
        if (invalid != null) {
            audit.record(name, args, "error: $invalid")
            return ToolResult.text(invalid, isError = true)
        }
        return try {
            val result = tool.call(args)
            audit.record(name, args, result.outcome)
            result
        } catch (error: ToolRefused) {
            audit.record(name, args, "refused: ${error.message}")
            ToolResult.text(error.message ?: "Refused.", isError = true, outcome = "refused")
        } catch (error: ToolFailed) {
            audit.record(name, args, "error: ${error.message}")
            ToolResult.text(error.message ?: "That failed.", isError = true)
        } catch (error: Exception) {
            val said = error.message ?: error.javaClass.simpleName
            audit.record(name, args, "error: $said")
            ToolResult.text("The phone could not do that: $said", isError = true)
        }
    }

    companion object {
        /** The MCP version every peer announces (peer-mcp-server.ts MCP_PROTOCOL_VERSION). */
        const val PROTOCOL_VERSION = "2025-06-18"
        const val SERVER_NAME = "intentic-device"
    }
}
