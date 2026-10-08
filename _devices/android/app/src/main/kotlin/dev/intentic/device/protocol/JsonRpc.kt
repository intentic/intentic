package dev.intentic.device.protocol

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import kotlin.math.floor

/** A failure the sandbox should read as the given JSON-RPC error: [REFUSED][PhoneWire.Error.REFUSED] for "paused", for example. */
class RpcError(val code: Int, message: String) : Exception(message)

/** What the phone answers to the four methods of the phone contract (_shared/sandbox-contract/src/contracts/phone.contract.ts). */
interface PhoneHandler {
    /** PhoneFacts. */
    fun describe(): JSONObject

    /** The owner's switches, pushed on connect and on every card edit. Unknown keys are ignored. Answers {"ok":true}. */
    fun setScopes(params: JSONObject): JSONObject

    /** Answers {"ok":true}. */
    fun ping(): JSONObject

    /** One MCP JSON-RPC message; the answer is the MCP response object verbatim, or JSONObject.NULL for a notification. */
    fun mcp(message: Any?): Any
}

/**
 * Plain JSON-RPC 2.0 over the socket, after the hello frame (_shared/sandbox-contract/src/protocol/doors/phone-protocol.ts).
 * The sandbox sends requests and the phone only answers: a frame that carries no method answers nothing we asked, and
 * a request without an id is a notification, so neither is replied to.
 */
class JsonRpcPeer(private val handler: PhoneHandler) {
    /** The frame to send back for one received frame, or null when it deserves no reply. Never throws. */
    fun handle(frame: String): String? {
        val parsed = parse(frame) ?: return failure(null, PhoneWire.Error.PARSE, "parse error").toString()
        if (parsed !is JSONObject) {
            // A batch or a bare value: this door never sends either.
            return failure(null, PhoneWire.Error.INVALID_REQUEST, "invalid request").toString()
        }
        return dispatch(parsed)?.toString()
    }

    private fun dispatch(request: JSONObject): JSONObject? {
        if (!request.has("method") || !request.has("id")) {
            return null
        }
        val id = idOf(request.opt("id")) ?: return failure(null, PhoneWire.Error.INVALID_REQUEST, "invalid request: id must be a non-negative integer")
        if (request.opt("jsonrpc") != "2.0") {
            return failure(id, PhoneWire.Error.INVALID_REQUEST, "invalid request: jsonrpc must be \"2.0\"")
        }
        val method = request.opt("method") as? String ?: return failure(id, PhoneWire.Error.INVALID_REQUEST, "invalid request: method must be a string")
        if (method !in PhoneWire.Method.ALL) {
            return failure(id, PhoneWire.Error.METHOD_NOT_FOUND, "method \"$method\" is not supported")
        }
        return try {
            val result: Any = when (method) {
                PhoneWire.Method.DESCRIBE -> handler.describe()
                PhoneWire.Method.PING -> handler.ping()
                PhoneWire.Method.SET_SCOPES -> {
                    val params = request.opt("params") as? JSONObject
                        ?: throw RpcError(PhoneWire.Error.INVALID_PARAMS, "setScopes takes an object with the owner's switches")
                    handler.setScopes(params)
                }
                else -> handler.mcp(if (request.has("params")) request.opt("params") else JSONObject.NULL)
            }
            success(id, result)
        } catch (error: RpcError) {
            failure(id, error.code, error.message ?: "refused")
        } catch (error: Exception) {
            failure(id, PhoneWire.Error.INTERNAL, error.message ?: "internal error")
        }
    }

    private fun success(id: Long, result: Any): JSONObject = JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result)

    private fun failure(id: Long?, code: Int, message: String): JSONObject =
        JSONObject().put("jsonrpc", "2.0").put("id", id ?: JSONObject.NULL).put("error", JSONObject().put("code", code).put("message", message))

    private fun idOf(value: Any?): Long? {
        if (value !is Number) {
            return null
        }
        val number = value.toDouble()
        return if (number >= 0 && number == floor(number) && number <= MAX_SAFE_ID) number.toLong() else null
    }

    /** The frame as JSON, or null when it is not. org.json would read `not json` as a bare string, so the first character decides. */
    private fun parse(frame: String): Any? {
        val first = frame.trimStart().firstOrNull() ?: return null
        return try {
            when (first) {
                '{' -> JSONObject(frame)
                '[' -> JSONArray(frame)
                else -> null
            }
        } catch (ignored: JSONException) {
            null
        }
    }

    private companion object {
        // JavaScript's largest exactly representable integer: the sandbox's ids are its own counter and never get near it.
        const val MAX_SAFE_ID = 9_007_199_254_740_991.0
    }
}
