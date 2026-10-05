package dev.intentic.device.touch

import dev.intentic.device.policy.Confirm
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppMode

/** Whether the agent may look at or act in the app on screen, and if not, the sentence that tells it why. */
sealed interface Access {
    class Granted(val app: AllowedApp) : Access

    class Refused(val message: String) : Access
}

/**
 * Which apps the touch tools reach. The person's allow-list decides: `read` lets the agent list the screen, `act` lets it
 * touch too. On top of that, some places are never actable whatever the list says, because they are where the person's own
 * consent lives: this app (its Allow button), the home screen, Settings, and the system's permission, install and shade
 * screens. An agent that could tap Allow in them could grant itself anything.
 */
class AppPolicy(
    private val ownPackage: String,
    private val launchers: () -> Set<String>,
    private val allowed: (String) -> AllowedApp?,
    private val destructiveOn: () -> Boolean,
) {
    fun neverActable(pkg: String): Boolean = pkg == ownPackage || pkg in launchers() || pkg in SYSTEM_CONSENT

    /** [label] is how the app is named in the refusal. [need] is what the call does: look (READ) or touch (ACT). */
    fun check(pkg: String?, label: String?, need: AppMode): Access {
        if (pkg == null) {
            return Access.Refused("Nothing is readable on the screen right now: there is no active window, so the screen may be off or locked. The person has to unlock the phone.")
        }
        val name = "\"${label ?: pkg}\" ($pkg)"
        val held = allowed(pkg)
            ?: return Access.Refused(
                "The app on screen, $name, is not one the person allowed you into. Call ask_access with app \"$pkg\" and a plain reason, then stop; do not look for another way in.",
            )
        if (need == AppMode.ACT) {
            if (neverActable(pkg)) {
                return Access.Refused(
                    "Acting in $name is not offered: it is this app, the home screen, Settings or one of Android's own permission and system screens, " +
                        "which are where the person's own consent lives. Ask the person to do that step themselves.",
                )
            }
            if (held.mode != AppMode.ACT) {
                return Access.Refused("The person let you look at $name but not act in it. Call ask_access with app \"$pkg\", mode \"act\" and a plain reason, then stop.")
            }
            if (held.sensitive && !destructiveOn()) {
                return Access.Refused(
                    "$name is marked sensitive on the phone, so acting in it needs \"Destructive actions\" switched on for this phone's card in the sandbox. " +
                        "Ask the person for that switch; do not look for another way in.",
                )
            }
        }
        return Access.Granted(held)
    }

    companion object {
        /** Android's own screens where consent is given, which no agent may touch even when the person allowed a lookalike. */
        val SYSTEM_CONSENT: Set<String> = setOf(
            "android",
            "com.android.settings",
            "com.android.settings.intelligence",
            "com.google.android.settings.intelligence",
            "com.android.systemui",
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller",
            "com.android.packageinstaller",
            "com.google.android.packageinstaller",
            "com.android.vending",
        )
    }
}

/** What one act is about to do, as far as the confirm rules care. */
class PlannedAct(
    /** tap, long_press, type, set_text, clear, scroll_*, focus, swipe. */
    val action: String,
    /** What the target is called, or "" for a point that names nothing. */
    val targetLabel: String,
    val targetIsPassword: Boolean,
    /** A password field has the keyboard now, so a tap at a point could be pressing its keys. */
    val passwordHasFocus: Boolean,
)

/**
 * When the person's own say-so is needed before an act, from the `confirm` setting of the phone's card:
 * "always" asks before every act, "never" never asks, and "sensitive" asks before typing into a password field and before
 * tapping something that reads like paying, buying, sending money, deleting, removing or transferring. An app the person
 * marked sensitive asks before every act in it, unless they said "never".
 */
object ConfirmRules {
    private val RISKY = Regex("""\b(pay\w*|buy\w*|purchas\w*|send\s+money|delet\w*|remov\w*|transfer\w*)""", RegexOption.IGNORE_CASE)

    private val TYPING = setOf("type", "set_text")
    private val TOUCHING = setOf("tap", "long_press", "swipe")

    fun risky(label: String): Boolean = RISKY.containsMatchIn(label)

    /** Why to ask the person, in a phrase that finishes "Your agent wants to ...", or null when no question is needed. */
    fun reason(confirm: Confirm, app: AllowedApp, act: PlannedAct): String? {
        val what = describe(act)
        return when (confirm) {
            Confirm.NEVER -> null
            Confirm.ALWAYS -> what
            Confirm.SENSITIVE -> when {
                act.action in TYPING && act.targetIsPassword -> "$what (a password field)"
                act.action in TOUCHING && act.passwordHasFocus -> "$what while a password field is waiting for input"
                act.action in TOUCHING && act.targetLabel.isNotEmpty() && risky(act.targetLabel) -> what
                app.sensitive -> "$what (${app.label} is marked sensitive)"
                else -> null
            }
        }
    }

    private fun describe(act: PlannedAct): String {
        val on = if (act.targetLabel.isEmpty()) "" else " \"${act.targetLabel}\""
        return when (act.action) {
            "tap" -> "tap$on"
            "long_press" -> "press and hold$on"
            "type", "set_text" -> "type into${if (on.isEmpty()) " a field" else on}"
            "clear" -> "clear${if (on.isEmpty()) " a field" else on}"
            "swipe" -> "swipe the screen"
            "focus" -> "select${if (on.isEmpty()) " a field" else on}"
            else -> "${act.action.replace('_', ' ')}$on"
        }
    }
}

/** The phone's navigation keys the `device` tool offers. Locking the screen and the power menu are not among them, and never will be. */
enum class Nav(val word: String) {
    BACK("back"),
    HOME("home"),
    RECENTS("recents"),
    NOTIFICATIONS("notifications"),
    QUICK_SETTINGS("quick_settings"),
}

object Navigation {
    /** Names that would lock the phone or open its power menu: nothing can unlock it again, and the person's own button does these. */
    private val FORBIDDEN = setOf("lock", "lock_screen", "lockscreen", "power", "power_dialog", "power_menu", "shutdown", "reboot", "sleep")

    fun refusal(name: String): String? =
        if (name.trim().lowercase() in FORBIDDEN) "Locking the screen and opening the power menu are not offered: nothing here could unlock the phone again. The person does those with the phone's own buttons." else null

    fun of(name: String): Nav? = Nav.entries.firstOrNull { it.word == name }
}

/** Whether an `enabled_accessibility_services` setting lists a service, in the full or the shortened form Android writes it. */
object ServiceSetting {
    fun enabled(setting: String?, pkg: String, cls: String): Boolean {
        if (setting.isNullOrBlank()) {
            return false
        }
        val full = "$pkg/$cls".lowercase()
        val short = "$pkg/${cls.removePrefix(pkg)}".lowercase()
        return setting.split(':').map { it.trim().lowercase() }.any { it == full || it == short }
    }
}
