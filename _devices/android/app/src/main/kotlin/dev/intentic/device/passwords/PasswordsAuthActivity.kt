package dev.intentic.device.passwords

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import dev.intentic.device.Graph
import dev.intentic.device.R
import org.json.JSONObject
import java.util.concurrent.Executor

/**
 * Shown when the person chooses "Fill with Intentic" on a sign-in form. Android's biometric gate unlocks the presence
 * key, which signs the fill request; the answer is unsealed and handed back to the autofill service.
 */
class PasswordsAuthActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pairing = Graph.pairings.get()
        val keyringDevice = intent.getStringExtra(EXTRA_KEYRING) ?: return refuse("No computer is set up for Passwords.")
        val originText = intent.getStringExtra(EXTRA_ORIGIN) ?: return refuse("This sign-in could not be read.")
        val usernameHint = intent.getStringExtra(EXTRA_USERNAME_HINT)
        val passwordId = IntentCompat.getParcelableExtra(intent, EXTRA_PASSWORD_ID, AutofillId::class.java)
            ?: return refuse("This sign-in could not be read.")
        val usernameId = IntentCompat.getParcelableExtra(intent, EXTRA_USERNAME_ID, AutofillId::class.java)
        val origin = JSONObject(originText)
        if (pairing == null) {
            return refuse("Pair this phone with your sandbox first.")
        }
        val keys = Graph.passwords.phoneKeys.load(this, pairing.id, android.os.Build.MODEL)
        val fill = PhoneFillRequest.build(keys.deviceId, origin, usernameHint)
        val executor: Executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(
            this,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    refuse(errString.toString())
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val signature = result.cryptoObject?.signature ?: return refuse("Could not sign this fill.")
                    Thread({
                        runFill(pairing, keyringDevice, fill, signature, keys, usernameId, passwordId)
                    }, "intentic-fill").start()
                }
            },
        )
        // A signing key behind the screen lock as well as a fingerprint is Android 11's (API 30) and later; before it, a
        // CryptoObject may only be unlocked by a strong biometric, which then needs a button to say no with.
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Fill with Intentic")
            .setSubtitle("Confirm it is you")
        val info = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(
                androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            ).build()
        } else {
            builder.setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
        }
        try {
            val signature = Graph.passwords.phoneKeys.signingSignature(this)
            prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
        } catch (error: Exception) {
            refuse("Passwords could not use your screen lock.")
        }
    }

    private fun runFill(
        pairing: dev.intentic.device.store.Pairing,
        keyringDevice: String,
        fill: JSONObject,
        signature: java.security.Signature,
        keys: PhoneKeys.Material,
        usernameId: AutofillId?,
        passwordId: AutofillId,
    ) {
        val payload = PhoneFillRequest.signedPayload(fill)
        val signed = try {
            signature.update(payload)
            PhoneFillRequest.wrapSigned(payload, signature.sign())
        } catch (error: Exception) {
            return runOnUiThread { refuse("Could not sign this fill.") }
        }
        when (val answer = Graph.passwords.client.fill(pairing, keyringDevice, signed)) {
            is PasswordsClient.Result.Ok -> {
                val nonce = fill.getString("nonce")
                val password = try {
                    Seal.unseal(keys.seal, answer.value.sealed, Seal.phoneAad(keys.deviceId, nonce))
                } catch (error: Exception) {
                    return runOnUiThread { refuse("The answer from your computer could not be opened.") }
                }
                val presentation = RemoteViews(packageName, R.layout.autofill_chip).apply {
                    setTextViewText(R.id.autofill_label, "Fill with Intentic")
                }
                val datasetBuilder = Dataset.Builder(presentation)
                answer.value.username?.let { username ->
                    usernameId?.let { id -> datasetBuilder.setValue(id, AutofillValue.forText(username)) }
                }
                datasetBuilder.setValue(passwordId, AutofillValue.forText(password))
                val clientState = android.os.Bundle().apply {
                    putCharSequence("username", answer.value.username)
                    putCharSequence("password", password)
                }
                val result = Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, datasetBuilder.build())
                    .putExtra(AutofillManager.EXTRA_CLIENT_STATE, clientState)
                setResult(Activity.RESULT_OK, result)
                finish()
            }
            is PasswordsClient.Result.Refused -> runOnUiThread { refuse(answer.message) }
        }
    }

    private fun refuse(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    companion object {
        const val EXTRA_KEYRING = "keyring"
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_USERNAME_HINT = "usernameHint"
        const val EXTRA_PASSWORD_ID = "passwordId"
        const val EXTRA_USERNAME_ID = "usernameId"

        fun intent(
            context: Context,
            keyringDevice: String,
            origin: JSONObject,
            usernameId: AutofillId?,
            passwordId: AutofillId,
        ): Intent =
            Intent(context, PasswordsAuthActivity::class.java)
                .putExtra(EXTRA_KEYRING, keyringDevice)
                .putExtra(EXTRA_ORIGIN, origin.toString())
                .putExtra(EXTRA_PASSWORD_ID, passwordId)
                .apply { usernameId?.let { putExtra(EXTRA_USERNAME_ID, it) } }
    }
}

// Dataset lives in autofill package; import alias for builder in this file.
private typealias Dataset = android.service.autofill.Dataset
