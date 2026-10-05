package dev.intentic.device.platform

import android.app.Application
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import dev.intentic.device.BuildConfig
import dev.intentic.device.Graph

/**
 * Firebase Cloud Messaging is how the sandbox wakes a sleeping phone, and it is optional. It is configured from four
 * Gradle properties (`intentic.fcm.*`, fed into BuildConfig), never from google-services.json. With any of them
 * empty this does nothing at all: Firebase is not started, the phone has no wake token, and `facts.wake` is left out.
 */
object FirebaseSupport {
    val configured: Boolean
        get() = listOf(BuildConfig.FCM_API_KEY, BuildConfig.FCM_APP_ID, BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_SENDER_ID).all { it.isNotBlank() }

    @Suppress("DEPRECATION")
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
                if (task.isSuccessful) {
                    Graph.settings.fcmToken = task.result
                    Graph.changes.fire()
                } else {
                    // No Google Play services, or no network yet: the phone just cannot be woken.
                    Log.w(TAG, "no push token", task.exception)
                }
            }
        } catch (error: RuntimeException) {
            Log.w(TAG, "Firebase did not start; the phone cannot be woken", error)
        }
    }

    private const val TAG = "IntenticPush"
}
