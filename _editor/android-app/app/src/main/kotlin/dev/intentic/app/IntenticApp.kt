package dev.intentic.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import dev.intentic.app.auth.PasskeyOrigin
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Config
import dev.intentic.app.core.Core
import dev.intentic.app.core.CoreStart
import dev.intentic.app.core.Request
import dev.intentic.app.core.RequestVisibleInner
import dev.intentic.app.secret.CoreSecret
import dev.intentic.app.secret.KeyWrap
import dev.intentic.app.secret.KeystoreKey
import dev.intentic.app.core.SessionState
import dev.intentic.app.state.AppState
import dev.intentic.app.ui.Looks
import dev.intentic.app.web.WebHost
import java.io.File
import java.security.GeneralSecurityException

/** Starts the Rust core once per process, before any screen, so it outlives them all. */
class IntenticApp : Application() {
    // Activities of this app on screen, and what the core was last told of it.
    private var shown = 0
    private var told: Boolean? = null
    @Volatile private var started = false

    override fun onCreate() {
        super.onCreate()
        Looks.load(this)
        registerActivityLifecycleCallbacks(Visibility())
        forgetTheWebOnSignOut()
        dev.intentic.app.push.PushSupport.init(this)
        // Off the main thread: loading the core's native library and unwrapping its secret through the Keystore are
        // what a cold start's first frame would otherwise wait on (the times are logged below). The first screen holds
        // the system's starting window until the core has said who is signed in, so nothing is drawn too early.
        Thread(::startCore, "core-start").start()
    }

    private fun startCore() {
        val began = SystemClock.elapsedRealtime()
        try {
            val secret = CoreSecret(File(noBackupFilesDir, "core-secret"), KeyWrap(KeystoreKey::get)).load()
            val unwrapped = SystemClock.elapsedRealtime()
            // Listening before the start, so the state the core says once as it boots is kept for the first screen.
            Core.observe { event ->
                Calls.answer(event)
                AppState.apply(event)
            }
            val config = Config(apiUrl = BuildConfig.API_URL, webUrl = BuildConfig.WEB_URL, secretKey = secret, passkeyOrigin = PasskeyOrigin.installed(this))
            Core.launch(filesDir, config)
            started = true
            CoreStart.started()
            Handler(Looper.getMainLooper()).post(::tell)
            Log.i(TAG, "secret unwrapped in ${unwrapped - began} ms, core loaded and started in ${SystemClock.elapsedRealtime() - unwrapped} ms")
        } catch (error: GeneralSecurityException) {
            fail("the Keystore refused the core's key", error)
        } catch (error: IllegalStateException) {
            fail("the core did not start", error)
        } catch (error: UnsatisfiedLinkError) {
            fail("the core's library would not load", error)
        }
    }

    /**
     * Whether a person is looking at the app, which the core passes on: out of sight it closes the sandbox's /events
     * stream, which would otherwise count them present and hold back their notifications. Counted over every activity,
     * so moving from the board to a conversation is not a moment out of sight.
     */
    private inner class Visibility : ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            shown++
            tell()
        }

        override fun onActivityStopped(activity: Activity) {
            shown--
            tell()
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

        override fun onActivityResumed(activity: Activity) = Unit

        override fun onActivityPaused(activity: Activity) = Unit

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    // Main thread. Before the core has started there is nobody to tell; it is told once it has.
    private fun tell() {
        val visible = shown > 0
        if (!started || told == visible) return
        told = visible
        Calls.send(Request.Visible(RequestVisibleInner(visible)))
    }

    // A sign-out seen here (from either side) clears the WebView's cookies and storage, so its page cannot keep the last
    // person. Only on the change from signed in: a start that is signed out from the first word must not load the
    // WebView just to clear it.
    private fun forgetTheWebOnSignOut() {
        var signedIn = false
        AppState.watch { snapshot ->
            val now = snapshot.session is SessionState.SignedIn
            if (signedIn && !now) WebHost.forget()
            signedIn = now
        }
    }

    // The config holds the secret, so only the error is logged, never what was being started.
    private fun fail(what: String, error: Throwable) {
        Log.e(TAG, what, error)
        val why = "$what: ${error.message}"
        Handler(Looper.getMainLooper()).post { AppState.failed(why) }
    }

    private companion object {
        const val TAG = "IntenticApp"
    }
}
