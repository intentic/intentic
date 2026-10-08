package dev.intentic.device.protocol

import org.json.JSONException
import org.json.JSONObject
import java.util.Base64

/**
 * The phone door's wire, as the sandbox defines it (_shared/sandbox-contract/src/protocol/doors/phone-protocol.ts and
 * phone-links.ts). Everything here is plain Kotlin over org.json, so it runs in a JVM unit test.
 */
object PhoneWire {
    /** How often the sandbox pings a connected phone. The app declares the link dead after three missed pings. */
    const val HEARTBEAT_MS = 60_000L

    /** How long an awake phone keeps its socket after its last `tools/call`, unless the person set it to stay connected. */
    const val LINGER_MS = 5 * 60_000L

    const val SILENCE_HEARTBEATS = 3
    const val SILENCE_MS = HEARTBEAT_MS * SILENCE_HEARTBEATS

    const val PAIR_HEADER = "x-intentic-pair"
    const val PAIR_LINK = "https://intentic.dev/phone/pair"

    /** The custom scheme the intentic.dev fallback page hands off to when App Link verification has not happened yet. */
    const val PAIR_SCHEME = "intentic-device"
    private const val PAIRING_PREFIX = "ixp1_"

    /** The four JSON-RPC methods the sandbox may call. */
    object Method {
        const val DESCRIBE = "describe"
        const val SET_SCOPES = "setScopes"
        const val PING = "ping"
        const val MCP = "mcp"
        val ALL = setOf(DESCRIBE, SET_SCOPES, PING, MCP)
    }

    /** JSON-RPC's own codes, plus the one the phone answers a refusal with. */
    object Error {
        const val PARSE = -32700
        const val INVALID_REQUEST = -32600
        const val METHOD_NOT_FOUND = -32601
        const val INVALID_PARAMS = -32602
        const val INTERNAL = -32603
        const val REFUSED = -32001
    }

    /** WebSocket close codes the sandbox uses (_sandbox/sandbox/src/peers/peer-routes.ts, peer-dial.ts). */
    object Close {
        const val NORMAL = 1000

        /** Going away: a peer that stopped answering. */
        const val GONE_QUIET = 1001

        /** The first frame was not a hello this build can read. Version skew costs a reconnect, not a pairing. */
        const val PROTOCOL_ERROR = 1002

        /** The sandbox read its enrollment store and does not hold this token: the pairing is revoked. Final. */
        const val UNAUTHORIZED = 1008

        /** The sandbox could not decide right now. Retried on the ordinary ladder. */
        const val TRY_AGAIN = 1013
    }

    private fun base(sandboxUrl: String): String = sandboxUrl.removeSuffix("/")

    /** The URL the phone dials. Carries no credential: the token rides the hello frame. */
    fun connectUrl(sandboxUrl: String): String = "${base(sandboxUrl).replaceFirst(Regex("^http"), "ws")}/system/phones/connect"

    /** Where the phone redeems its one-time pairing for its durable token (header [PAIR_HEADER]). */
    fun enrollUrl(sandboxUrl: String): String = "${base(sandboxUrl)}/system/phones/enroll"

    /** The first frame on a fresh socket. */
    fun hello(token: String, version: String): String =
        JSONObject().put("type", "hello").put("token", token).put("version", version).toString()

    data class Pairing(val url: String, val token: String)

    /**
     * What a pasted code or a scanned link carries: base64url of {url, token} after the `ixp1_` prefix. It arrives bare,
     * or in the fragment of a link, so everything after a `#` is the code: `https://intentic.dev/phone/pair#ixp1_...`,
     * the same with a trailing slash (`/phone/pair/#ixp1_...`, as intentic.dev serves its pages), or
     * `intentic-device://pair#ixp1_...`. Null for anything not one of ours.
     */
    fun parsePairingCode(input: String): Pairing? {
        val trimmed = input.trim()
        val code = if (trimmed.contains('#')) trimmed.substringAfter('#') else trimmed
        if (!code.startsWith(PAIRING_PREFIX)) {
            return null
        }
        return try {
            // The sender writes the URL-safe alphabet without padding; both alphabets are read, as the sandbox's own parser does.
            val normalized = code.substring(PAIRING_PREFIX.length).replace('-', '+').replace('_', '/')
            val decoded = JSONObject(String(Base64.getDecoder().decode(normalized), Charsets.UTF_8))
            val url = decoded.opt("url") as? String
            val token = decoded.opt("token") as? String
            if (url == null || token == null || token.isEmpty() || !Regex("^https?://").containsMatchIn(url)) null else Pairing(url, token)
        } catch (ignored: IllegalArgumentException) {
            null
        } catch (ignored: JSONException) {
            null
        }
    }
}
