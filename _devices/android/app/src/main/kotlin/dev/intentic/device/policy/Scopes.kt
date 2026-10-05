package dev.intentic.device.policy

import dev.intentic.device.store.KeyValue
import org.json.JSONException
import org.json.JSONObject

/**
 * The owner's switches on the phone's card in the sandbox, named as the card shows them (_shared/capability-catalog
 * PHONE_SCOPE_FIELDS), because a refusal quotes the label the owner will look for.
 */
enum class Switch(val key: String, val label: String) {
    SCREEN("screen", "See the screen"),
    CONTROL("control", "Tap, swipe and type"),
    FILES("files", "Read the folders you pick"),
    WRITE("write", "Change files in those folders"),
    NOTIFICATIONS("notifications", "Read notifications"),
    APPS("apps", "Open apps and links"),
    DESTRUCTIVE("destructive", "Destructive actions"),
}

/** How often the phone asks its owner before acting in an app. Stored now, enforced by stage 2's touch tools. */
enum class Confirm(val key: String) {
    SENSITIVE("sensitive"),
    ALWAYS("always"),
    NEVER("never"),
}

/** The grant from the last `setScopes`. A switch the sandbox did not send, or sent as anything but "on", is off. */
data class Scopes(val on: Set<Switch>, val confirm: Confirm) {
    fun allows(switch: Switch): Boolean = switch in on

    fun toJson(): JSONObject {
        val json = JSONObject()
        for (switch in Switch.entries) {
            json.put(switch.key, if (allows(switch)) "on" else "off")
        }
        return json.put("confirm", confirm.key)
    }

    companion object {
        /** From `setScopes` params. Unknown keys (`platform`, a switch a newer sandbox added) are ignored. */
        fun fromParams(params: JSONObject): Scopes {
            val on = Switch.entries.filter { params.opt(it.key) == "on" }.toSet()
            val confirm = when (val said = params.opt("confirm")) {
                null, JSONObject.NULL -> Confirm.SENSITIVE
                else -> Confirm.entries.firstOrNull { it.key == said } ?: Confirm.ALWAYS
            }
            return Scopes(on, confirm)
        }

        fun fromStored(text: String): Scopes? =
            try {
                fromParams(JSONObject(text))
            } catch (ignored: JSONException) {
                null
            }
    }
}

/**
 * The grant, persisted so a restart enforces the last one the sandbox sent. Null until the sandbox has sent one at all,
 * and cleared when the pairing goes, so a new sandbox never inherits an old one's grant.
 */
class ScopeStore(private val kv: KeyValue) {
    @Volatile
    private var held: Scopes? = kv.getString(KEY)?.let(Scopes::fromStored)

    fun current(): Scopes? = held

    fun update(params: JSONObject): Scopes {
        val scopes = Scopes.fromParams(params)
        kv.putString(KEY, scopes.toJson().toString())
        held = scopes
        return scopes
    }

    fun clear() {
        kv.putString(KEY, null)
        held = null
    }

    private companion object {
        const val KEY = "scopes"
    }
}
