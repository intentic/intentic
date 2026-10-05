package dev.intentic.device

import dev.intentic.device.protocol.JsonRpcPeer
import dev.intentic.device.protocol.PhoneHandler
import dev.intentic.device.protocol.PhoneWire
import dev.intentic.device.protocol.RpcError
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * _shared/sandbox-contract/golden/phone-wire.json holds the example frames both ends test against: the sandbox's
 * JSON-RPC link sends exactly each `request`, and this app's must answer in the shape of each `response`.
 */
class GoldenWireTest {
    private val golden: JSONObject = JSONObject(File(requireNotNull(System.getProperty("intentic.golden.phoneWire")) { "the build passes the golden file's path" }).readText())
    private val exchanges: List<JSONObject> = golden.getJSONArray("exchanges").let { array -> (0 until array.length()).map { array.getJSONObject(it) } }

    /** A handler that answers each golden request with the golden response's own result (or error), remembering what it was asked. */
    private class Scripted(private val exchange: JSONObject) : PhoneHandler {
        var received: Any? = null
        private fun answer(): JSONObject {
            val response = exchange.getJSONObject("response")
            if (response.has("error")) {
                val error = response.getJSONObject("error")
                throw RpcError(error.getInt("code"), error.getString("message"))
            }
            return response.getJSONObject("result")
        }
        override fun describe() = answer()
        override fun setScopes(params: JSONObject): JSONObject {
            received = params
            return answer()
        }
        override fun ping() = answer()
        override fun mcp(message: Any?): Any {
            received = message
            return answer()
        }
    }

    @Test
    fun `every golden request is answered in the shape of its golden response, with the same id`() {
        assertTrue("the golden file lists exchanges", exchanges.isNotEmpty())
        for (exchange in exchanges) {
            val request = exchange.getJSONObject("request")
            val handler = Scripted(exchange)
            val reply = JsonRpcPeer(handler).handle(request.toString())
            assertNotNull("${exchange.getString("name")} is answered", reply)
            JsonAssert.same(exchange.getJSONObject("response"), JSONObject(reply!!), exchange.getString("name"))
            // The params the sandbox sent reach the handler untouched.
            if (request.has("params")) {
                JsonAssert.same(request.get("params"), handler.received, "${exchange.getString("name")} params")
            }
        }
    }

    @Test
    fun `the golden refusal is a JSON-RPC error with the refusal code`() {
        val refused = exchanges.single { it.has("rejects") }
        val error = JSONObject(JsonRpcPeer(Scripted(refused)).handle(refused.getJSONObject("request").toString())!!).getJSONObject("error")
        assertEquals(PhoneWire.Error.REFUSED, error.getInt("code"))
        assertEquals(refused.getString("rejects"), error.getString("message"))
    }

    @Test
    fun `the hello frame has the shape of the golden hello`() {
        val expected = golden.getJSONObject("hello")
        val ours = JSONObject(PhoneWire.hello(expected.getString("token"), expected.getString("version")))
        JsonAssert.same(expected, ours)
    }

    @Test
    fun `the real handler answers the golden requests with the same ids and result shapes`() {
        val phone = FakePhone()
        for (exchange in exchanges.filter { !it.has("rejects") }) {
            val request = exchange.getJSONObject("request")
            val reply = JSONObject(phone.rpc.handle(request.toString())!!)
            val expected = exchange.getJSONObject("response")
            assertEquals(exchange.getString("name"), expected.get("id"), reply.get("id"))
            assertEquals("2.0", reply.getString("jsonrpc"))
            assertTrue("${exchange.getString("name")} has a result", reply.has("result"))
            when (request.getString("method")) {
                "setScopes", "ping" -> JsonAssert.same(expected.getJSONObject("result"), reply.getJSONObject("result"))
                "describe" -> assertEquals(keysOf(expected.getJSONObject("result"), required = true), keysOf(reply.getJSONObject("result"), required = true))
                "mcp" -> {
                    // The MCP response keeps the inner id verbatim, string or number, and a tool table.
                    val inner = reply.getJSONObject("result")
                    assertEquals(request.getJSONObject("params").get("id"), inner.get("id"))
                    assertTrue(inner.has("result"))
                }
            }
        }
    }

    // The keys PhoneFactsSchema requires; battery, wake and features are optional and a build may omit them.
    private fun keysOf(facts: JSONObject, required: Boolean): Set<String> =
        facts.keys().asSequence().filter { !required || it !in setOf("battery", "wake", "features") }.toSet()

    @Test
    fun `describe facts carry exactly the fields PhoneFacts asks for, with the right types`() {
        val facts = FakePhone().call("describe").getJSONObject("result")
        assertTrue(facts.get("device") is String)
        assertTrue(facts.get("android") is String)
        assertTrue(facts.get("sdk") is Int)
        assertTrue(facts.get("build") is String)
        assertTrue(facts.get("paused") is Boolean)
        val access = facts.getJSONObject("access")
        assertEquals(false, access.getBoolean("accessibility"))
        assertEquals(false, access.getBoolean("notifications"))
        assertTrue(access.get("screenCapture") is String)
        assertTrue(facts.get("folders") is JSONArray)
        assertTrue(facts.get("apps") is JSONArray)
        val battery = facts.getJSONObject("battery")
        assertTrue(battery.getInt("level") in 0..100)
        // No Firebase token was given, so there is no `wake`.
        assertTrue(!facts.has("wake"))
    }
}
