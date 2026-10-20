package dev.intentic.app.auth

import android.app.Activity
import android.os.CancellationSignal
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.core.content.ContextCompat
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import dev.intentic.app.BuildConfig

/**
 * Google's own sign-in sheet through Credential Manager, for an ID token minted for the WEB client id: the token the
 * platform's one-tap callback and every daemon already accept. Google answers only an app whose package and signing
 * certificate are registered as an Android OAuth client in the same Google Cloud project (README.md).
 */
class GoogleSignIn(private val activity: Activity) {
    /** Calls [token] with the ID token, or [failed] with why (null when the person closed the sheet). */
    fun start(token: (String) -> Unit, failed: (String?) -> Unit) {
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_CLIENT_ID).build())
            .build()
        val answer = object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
            override fun onResult(result: GetCredentialResponse) {
                val credential = result.credential
                if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    failed("Google answered with a credential of another kind (${credential.type})")
                    return
                }
                try {
                    token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
                } catch (error: GoogleIdTokenParsingException) {
                    failed(error.message)
                }
            }

            override fun onError(e: GetCredentialException) {
                when (e) {
                    // Closed by the person: nothing to say.
                    is GetCredentialCancellationException -> failed(null)
                    // No Google account here, or none this app may use (its OAuth client is not registered): Google's words.
                    is NoCredentialException -> failed(e.message ?: e.type)
                    else -> failed(e.message ?: e.type)
                }
            }
        }
        CredentialManager.create(activity).getCredentialAsync(activity, request, CancellationSignal(), ContextCompat.getMainExecutor(activity), answer)
    }
}
