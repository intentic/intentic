package dev.intentic.device.passwords

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Reads `_shared/sandbox-contract/golden/keyring-seal.json`, the same vectors as `keyring-seal.test.ts`. */
class SealGoldenTest {
    private val golden = JSONObject(File(requireNotNull(System.getProperty("intentic.golden.keyringSeal")) { "gradle passes the golden path" }).readText())

    @Test
    fun `capture vector matches TypeScript`() {
        val vector = golden.getJSONArray("vectors").let { array ->
            (0 until array.length()).map { array.getJSONObject(it) }.single { it.getString("name") == "capture" }
        }
        val recipient = golden.getJSONObject("recipient").getString("publicKey")
        val ephemeral = vector.getJSONObject("ephemeral")
        val pair = Seal.KeyPair(ephemeral.getString("publicKey"), ephemeral.getString("privateKey"))
        val purpose = vector.getJSONObject("purpose")
        val aad = Seal.captureAad(purpose.getString("via"), purpose.getLong("at"))
        val iv = Base64Url.decode(vector.getString("iv"))
        val box = Seal.seal(recipient, vector.getString("plaintext"), aad, pair, iv)
        assertBox(vector.getJSONObject("box"), box)
    }

    @Test
    fun `phone vector opens on the phone seal key`() {
        val vector = golden.getJSONArray("vectors").let { array ->
            (0 until array.length()).map { array.getJSONObject(it) }.single { it.getString("name") == "phone" }
        }
        val phone = golden.getJSONObject("phone")
        val pair = Seal.KeyPair(phone.getString("publicKey"), phone.getString("privateKey"))
        val purpose = vector.getJSONObject("purpose")
        val aad = Seal.phoneAad(purpose.getString("device"), purpose.getString("nonce"))
        val boxJson = vector.getJSONObject("box")
        val box = Seal.Box(boxJson.getInt("v"), boxJson.getString("epk"), boxJson.getString("iv"), boxJson.getString("tag"), boxJson.getString("data"))
        assertEquals(golden.getJSONObject("unseal").getString("phonePlaintext"), Seal.unseal(pair, box, aad))
    }

    private fun assertBox(expected: JSONObject, actual: Seal.Box) {
        assertEquals(expected.getInt("v"), actual.v)
        assertEquals(expected.getString("epk"), actual.epk)
        assertEquals(expected.getString("iv"), actual.iv)
        assertEquals(expected.getString("tag"), actual.tag)
        assertEquals(expected.getString("data"), actual.data)
    }
}
