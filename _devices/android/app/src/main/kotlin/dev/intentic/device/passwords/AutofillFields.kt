package dev.intentic.device.passwords

import android.text.InputType
import org.json.JSONObject

/**
 * Heuristics for username and password fields, factored out of [IntenticAutofillService] so unit tests can classify
 * plain data without an [android.view.autofill.AssistStructure].
 */
object AutofillFields {
    data class Hint(val autofillHints: List<String>, val inputType: Int, val idEntry: String?, val hint: String?, val webDomain: String?, val packageName: String)

    data class Parsed(val origin: JSONObject, val usernameId: String?, val passwordId: String?, val skip: Boolean)

    private val OTP_HINTS = setOf("otp", "sms_otp", "oneTimeCode")
    private val CARD_HINTS = setOf("creditCardNumber", "creditCardSecurityCode", "creditCardExpirationDate")

    fun parse(fields: List<Pair<String, Hint>>): Parsed {
        var usernameId: String? = null
        var passwordId: String? = null
        var webDomain: String? = null
        var packageName: String? = null
        for ((id, hint) in fields) {
            if (hint.skipCredential()) {
                continue
            }
            webDomain = webDomain ?: hint.webDomain
            packageName = packageName ?: hint.packageName
            if (passwordId == null && hint.looksLikePassword()) {
                passwordId = id
            } else if (usernameId == null && hint.looksLikeUsername()) {
                usernameId = id
            }
        }
        val origin = when {
            !webDomain.isNullOrBlank() -> JSONObject().put("kind", "site").put("host", normalizeHost(webDomain))
            !packageName.isNullOrBlank() -> JSONObject().put("kind", "package").put("package", packageName)
            else -> JSONObject().put("kind", "package").put("package", "unknown")
        }
        val skip = passwordId == null
        return Parsed(origin, usernameId, passwordId, skip)
    }

    private fun Hint.skipCredential(): Boolean {
        val lowered = autofillHints.map { it.lowercase() }
        if (lowered.any { it in OTP_HINTS || it in CARD_HINTS }) {
            return true
        }
        val text = listOfNotNull(idEntry, hint).joinToString(" ").lowercase()
        return text.contains("otp") || text.contains("cvv") || text.contains("cvc") || text.contains("credit")
    }

    private fun Hint.looksLikePassword(): Boolean {
        if (autofillHints.any { it.equals("password", ignoreCase = true) }) {
            return true
        }
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        if (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
            variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
        ) {
            return true
        }
        val text = listOfNotNull(idEntry, hint).joinToString(" ").lowercase()
        return text.contains("password") || text.contains("passcode")
    }

    private fun Hint.looksLikeUsername(): Boolean {
        if (autofillHints.any { it.equals("username", ignoreCase = true) || it.equals("emailAddress", ignoreCase = true) }) {
            return true
        }
        val text = listOfNotNull(idEntry, hint).joinToString(" ").lowercase()
        return text.contains("user") || text.contains("email") || text.contains("account") || text.contains("login")
    }

    private fun normalizeHost(host: String): String = host.removePrefix("www.").lowercase()
}
