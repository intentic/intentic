package dev.intentic.device.protocol

import dev.intentic.device.policy.ScopeStore
import org.json.JSONObject

/** The production [PhoneHandler]: facts from the phone, switches into the store, MCP into the server. */
class PhonePeer(
    private val facts: () -> JSONObject,
    private val scopes: ScopeStore,
    private val mcp: McpServer,
) : PhoneHandler {
    override fun describe(): JSONObject = facts()

    override fun setScopes(params: JSONObject): JSONObject {
        scopes.update(params)
        return JSONObject().put("ok", true)
    }

    override fun ping(): JSONObject = JSONObject().put("ok", true)

    override fun mcp(message: Any?): Any = mcp.handle(message)
}
