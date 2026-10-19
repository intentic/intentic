package dev.intentic.device.passwords

import android.text.InputType
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class AutofillFieldsTest {
    @Test
    fun `finds username and password on a sign-in form`() {
        val fields = listOf(
            "username" to hint(autofillHints = listOf("username"), inputType = InputType.TYPE_CLASS_TEXT),
            "password" to hint(autofillHints = listOf("password"), inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD),
        )
        val parsed = AutofillFields.parse(fields)
        assertFalse(parsed.skip)
        assertEquals("username", parsed.usernameId)
        assertEquals("password", parsed.passwordId)
        assertEquals("github.com", parsed.origin.getString("host"))
    }

    @Test
    fun `skips otp fields`() {
        val fields = listOf("otp" to hint(autofillHints = listOf("sms_otp"), inputType = InputType.TYPE_CLASS_NUMBER))
        val parsed = AutofillFields.parse(fields)
        assertNull(parsed.passwordId)
        assertEquals(true, parsed.skip)
    }

    @Test
    fun `uses the app package when there is no web domain`() {
        val fields = listOf(
            "pw" to hint(
                autofillHints = listOf("password"),
                inputType = InputType.TYPE_TEXT_VARIATION_PASSWORD,
                packageName = "com.example.app",
            ),
        )
        val parsed = AutofillFields.parse(fields)
        assertEquals("package", parsed.origin.getString("kind"))
        assertEquals("com.example.app", parsed.origin.getString("package"))
    }

    private fun hint(
        autofillHints: List<String> = emptyList(),
        inputType: Int = 0,
        idEntry: String? = null,
        hint: String? = null,
        webDomain: String? = "github.com",
        packageName: String = "com.android.chrome",
    ): AutofillFields.Hint = AutofillFields.Hint(autofillHints, inputType, idEntry, hint, webDomain, packageName)
}
