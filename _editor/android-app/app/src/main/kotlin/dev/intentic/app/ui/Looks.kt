package dev.intentic.app.ui

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.view.ContextThemeWrapper

/**
 * The look the app wears, one of the web's four (Settings ▸ Appearance): `system` follows the phone, `light` and `dark`
 * pin a scheme, and `sanctum` is the web's dark skin, which the native screens draw as dark. The web's settings change it
 * (the WebView's `setLook`), it is kept across starts, and the WebView is handed it on its first load.
 */
object Looks {
    private const val PREFS = "look"
    private const val KEY = "look"
    val NAMES = setOf("system", "light", "dark", "sanctum")

    @Volatile var name = "system"
        private set

    /** Night over the phone's own setting, or null to follow it. */
    @Volatile var night: Boolean? = null

    /** Moves on with every change, so a screen made before it knows to be made again. */
    @Volatile var generation = 0
        private set

    fun load(context: Context) {
        choose(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "system") ?: "system", null)
    }

    /** Wears [look] app-wide, and keeps it when [context] is given. A word not among [NAMES] is ignored. */
    fun choose(look: String, context: Context?) {
        if (look !in NAMES) return
        context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putString(KEY, look)?.apply()
        if (look == name && generation > 0) return
        name = look
        night = when (look) {
            "light" -> false
            "dark", "sanctum" -> true
            else -> null
        }
        generation++
    }

    /** Called from an activity's attachBaseContext, before anything reads its resources. */
    fun apply(activity: ContextThemeWrapper, base: Configuration) {
        val night = night ?: return
        val mode = if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        activity.applyOverrideConfiguration(
            Configuration().apply { uiMode = (base.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or mode },
        )
    }

    /** An activity made under an older look is made again: called from its onResume with the generation it was made in. */
    fun refresh(activity: Activity, madeIn: Int) {
        if (madeIn != generation) activity.recreate()
    }
}
