package dev.intentic.device.policy

import dev.intentic.device.tools.Tool

/**
 * The one place a `tools/call` is allowed or refused. Everything else the sandbox asks (describe, setScopes, ping, MCP
 * initialize, ping and tools/list) is answered whatever the owner has switched off or paused.
 *
 * In this order: the owner paused the agent; the sandbox has never sent its switches (so every one counts as off);
 * Android is hiding the "agent is connected" notice, which the owner is promised; the tool's own switch is off.
 */
class Gate(
    private val scopes: () -> Scopes?,
    private val paused: () -> Boolean,
    private val noticeVisible: () -> Boolean = { true },
) {
    /** The sentence the agent reads when this call is refused, or null when it may run. [tool] is null for a name nobody knows. */
    fun refusal(tool: Tool?): String? {
        if (paused()) {
            return PAUSED
        }
        val granted = scopes() ?: return NOT_GRANTED_YET
        if (!noticeVisible()) {
            return NOTICE_HIDDEN
        }
        val needs = tool?.needs ?: return null
        return if (granted.allows(needs)) null else switchOff(needs)
    }

    companion object {
        const val PAUSED = "The person paused the agent on this phone."
        const val NOT_GRANTED_YET = "Refused: this phone has not received its permissions from the sandbox yet, so every switch counts as off."
        const val NOTICE_HIDDEN =
            "Refused: Android is hiding Intentic Device's notification, so the person could not see that the agent is connected."

        fun switchOff(switch: Switch): String = "Refused: \"${switch.label}\" is switched off for this phone."
    }
}
