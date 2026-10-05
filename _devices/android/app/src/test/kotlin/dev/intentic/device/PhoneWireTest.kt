package dev.intentic.device

import dev.intentic.device.protocol.EnrollResult
import dev.intentic.device.protocol.Enrollment
import dev.intentic.device.protocol.PhoneWire
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The same cases as _shared/sandbox-contract/src/protocol/phone-protocol.test.ts, on the app's side of the code. */
class PhoneWireTest {
    private fun code(url: String, token: String): String {
        val json = JSONObject().put("url", url).put("token", token).toString()
        return "ixp1_" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
    }

    private fun link(url: String, token: String) = "${PhoneWire.PAIR_LINK}#${code(url, token)}"

    @Test
    fun `a pairing round-trips as a code and as the link the QR carries`() {
        val pairing = PhoneWire.Pairing("https://sandbox-abc.sbx.intentic.dev", "one-time")
        assertEquals(pairing, PhoneWire.parsePairingCode(code(pairing.url, pairing.token)))
        assertEquals(pairing, PhoneWire.parsePairingCode(link(pairing.url, pairing.token)))
        assertTrue(link(pairing.url, pairing.token).startsWith("https://intentic.dev/phone/pair#ixp1_"))
    }

    @Test
    fun `a link may end its path with a slash or use the custom scheme the fallback page hands off to`() {
        val pairing = PhoneWire.Pairing("https://sandbox-abc.sbx.intentic.dev", "one-time")
        val bare = code(pairing.url, pairing.token)
        assertEquals(pairing, PhoneWire.parsePairingCode("https://intentic.dev/phone/pair/#$bare"))
        assertEquals(pairing, PhoneWire.parsePairingCode("intentic-device://pair#$bare"))
        assertEquals(pairing, PhoneWire.parsePairingCode("intentic-device://pair/#$bare"))
        assertNull(PhoneWire.parsePairingCode("https://intentic.dev/phone/pair/#ixb1_abc"))
        assertNull(PhoneWire.parsePairingCode("https://intentic.dev/phone/pair"))
    }

    @Test
    fun `a pasted code or link may carry surrounding whitespace`() {
        val pairing = PhoneWire.Pairing("https://sandbox-abc.sbx.intentic.dev", "one-time")
        assertEquals(pairing, PhoneWire.parsePairingCode("  ${link(pairing.url, pairing.token)}\n"))
    }

    @Test
    fun `a code that is not ours, or carries no usable url or token, is refused rather than attempted`() {
        assertNull(PhoneWire.parsePairingCode("ixb1_abc"))
        assertNull(PhoneWire.parsePairingCode("ixp1_not-base64!"))
        assertNull(PhoneWire.parsePairingCode(code("ftp://x", "t")))
        assertNull(PhoneWire.parsePairingCode(code("https://x", "")))
        assertNull(PhoneWire.parsePairingCode(""))
        assertNull(PhoneWire.parsePairingCode("ixp1_" + Base64.getUrlEncoder().withoutPadding().encodeToString("not json".toByteArray())))
        assertNull(PhoneWire.parsePairingCode("ixp1_" + Base64.getUrlEncoder().withoutPadding().encodeToString("{\"url\":5,\"token\":\"t\"}".toByteArray())))
    }

    @Test
    fun `the phone dials and enrolls at the sandbox's own address`() {
        assertEquals("wss://sandbox-abc.sbx.intentic.dev/system/phones/connect", PhoneWire.connectUrl("https://sandbox-abc.sbx.intentic.dev/"))
        assertEquals("ws://localhost:3000/system/phones/connect", PhoneWire.connectUrl("http://localhost:3000"))
        assertEquals("https://sandbox-abc.sbx.intentic.dev/system/phones/enroll", PhoneWire.enrollUrl("https://sandbox-abc.sbx.intentic.dev"))
    }

    @Test
    fun `the first frame is a hello with the token and the build`() {
        val hello = JSONObject(PhoneWire.hello("iph_x", "1.2.3"))
        assertEquals("hello", hello.getString("type"))
        assertEquals("iph_x", hello.getString("token"))
        assertEquals("1.2.3", hello.getString("version"))
    }

    @Test
    fun `an enrollment is read as an id and a token, and a refusal keeps the sandbox's own words`() {
        assertEquals(EnrollResult.Enrolled("pixel", "iph_t"), Enrollment.interpret(200, """{"id":"pixel","token":"iph_t"}"""))
        assertEquals(EnrollResult.Refused("that code has expired"), Enrollment.interpret(401, """{"error":"that code has expired"}"""))
        assertTrue(Enrollment.interpret(401, "").let { it is EnrollResult.Refused })
        assertTrue(Enrollment.interpret(200, """{"id":"pixel"}""").let { it is EnrollResult.Refused })
        assertTrue((Enrollment.interpret(502, "<html>") as EnrollResult.Refused).message.contains("502"))
    }
}
