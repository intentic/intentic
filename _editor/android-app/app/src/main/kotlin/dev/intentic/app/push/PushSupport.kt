package dev.intentic.app.push

import android.app.Application
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import dev.intentic.app.BuildConfig
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Outcome
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestRegisterPushInner
import dev.intentic.app.core.SessionState
import dev.intentic.app.state.AppState

/**
 * Notifications through Firebase Messaging, configured from BuildConfig (the app's Firebase identifiers, in
 * build.gradle.kts), not a google-services.json; a build with the API key blanked out starts no Firebase at all. The
 * token is registered by the core on the platform's relay and on every sandbox (`RegisterPush`), once signed in and
 * again whenever the list of sandboxes changes; the core skips a sandbox it already registered under the same token.
 */
object PushSupport {
    @Volatile private var token: String? = null
    private var registeredFor: Pair<String, Set<String>>? = null

    val configured: Boolean get() = BuildConfig.FCM_API_KEY.isNotBlank()

    fun init(app: Application) {
        if (!configured) {
            return
        }
        try {
            if (FirebaseApp.getApps(app).isEmpty()) {
                FirebaseApp.initializeApp(
                    app,
                    FirebaseOptions.Builder()
                        .setApiKey(BuildConfig.FCM_API_KEY)
                        .setApplicationId(BuildConfig.FCM_APP_ID)
                        .setProjectId(BuildConfig.FCM_PROJECT_ID)
                        .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                        .build(),
                )
            }
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) tokenIs(task.result) else Log.w(TAG, "no push token", task.exception)
            }
            AppState.watch { register() }
        } catch (error: RuntimeException) {
            Log.w(TAG, "Firebase did not start; this phone gets no notifications", error)
        }
    }

    /** A token, new or rotated (Firebase's `onNewToken`). */
    fun tokenIs(next: String) {
        token = next
        register()
    }

    @Synchronized
    private fun register() {
        val token = token ?: return
        val snapshot = AppState.snapshot
        if (snapshot.session !is SessionState.SignedIn || snapshot.sandboxes.isEmpty()) {
            return
        }
        val target = token to snapshot.sandboxes.map { it.id }.toSet()
        if (registeredFor == target) {
            return
        }
        registeredFor = target
        Calls.send(Request.RegisterPush(RequestRegisterPushInner(token = token))) { outcome ->
            if (outcome is Outcome.Failed) {
                Log.w(TAG, "push registration: ${outcome.content.message}")
                synchronized(this) { registeredFor = null }
            }
        }
    }

    private const val TAG = "IntenticPush"
}
