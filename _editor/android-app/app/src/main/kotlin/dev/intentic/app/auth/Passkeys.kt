package dev.intentic.app.auth

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestPasskeyOptionsInner
import dev.intentic.app.core.RequestPasskeyResponseInner

/**
 * A sandbox that requires a passkey (LinkState.PasskeyRequired): the core asks the daemon for the ceremony's options,
 * Credential Manager runs it (sign in with a passkey this person has, or add one), and the core hands the answer back
 * and reconnects by itself. [done] gets the core's or Credential Manager's words when it failed, null when it went
 * through or the person closed the sheet.
 */
class Passkeys(private val activity: Activity) {
    fun run(sandbox: String, register: Boolean, done: (String?) -> Unit) {
        // Credential Manager carries passkeys from Android 9 on; before that there is no ceremony to run.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            done("")
            return
        }
        Calls.send(Request.PasskeyOptions(RequestPasskeyOptionsInner(sandbox = sandbox, register = register))) { outcome ->
            when (outcome) {
                is Outcome.PasskeyOptions -> ceremony(sandbox, register, outcome.content.json, done)
                is Outcome.Failed -> done(outcome.content.message)
                else -> done(null)
            }
        }
    }

    @SuppressLint("PublicKeyCredential") // run() goes no further than this before Android 9
    @RequiresApi(Build.VERSION_CODES.P)
    private fun ceremony(sandbox: String, register: Boolean, options: String, done: (String?) -> Unit) {
        val manager = CredentialManager.create(activity)
        val executor = ContextCompat.getMainExecutor(activity)
        val answer = { json: String -> respond(sandbox, register, json, done) }
        if (register) {
            manager.createCredentialAsync(activity, CreatePublicKeyCredentialRequest(options), CancellationSignal(), executor,
                object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                    override fun onResult(result: CreateCredentialResponse) {
                        (result as? CreatePublicKeyCredentialResponse)?.let { answer(it.registrationResponseJson) } ?: done(null)
                    }

                    override fun onError(e: CreateCredentialException) =
                        done(if (e is CreateCredentialCancellationException) null else e.message ?: e.type)
                })
        } else {
            manager.getCredentialAsync(activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(options))), CancellationSignal(), executor,
                object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                    override fun onResult(result: GetCredentialResponse) {
                        (result.credential as? PublicKeyCredential)?.let { answer(it.authenticationResponseJson) } ?: done(null)
                    }

                    override fun onError(e: GetCredentialException) =
                        done(if (e is GetCredentialCancellationException) null else e.message ?: e.type)
                })
        }
    }

    private fun respond(sandbox: String, register: Boolean, json: String, done: (String?) -> Unit) {
        Calls.send(Request.PasskeyResponse(RequestPasskeyResponseInner(sandbox = sandbox, register = register, json = json))) { outcome ->
            done((outcome as? Outcome.Failed)?.content?.message)
        }
    }
}
