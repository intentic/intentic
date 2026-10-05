package dev.intentic.device.protocol

import kotlin.math.max
import kotlin.math.min

/**
 * How often a link nobody is answering may try again; the Kotlin half of _shared/sandbox-contract/src/protocol/peer-dial.ts.
 * The ladder is 1s, 2s, 4s, 8s, 16s, then 30s. A link that held for [STABLE_MS] earns the floor back on its next drop,
 * and after [LONG_OUTAGE_ATTEMPTS] failures in a row it asks at most every [LONG_OUTAGE_MS]. An open link resets the count.
 */
class DialPolicy {
    private var rung = FLOOR_MS
    private var failures = 0

    /** The socket opened: the sandbox was reached, so the outage count starts over. */
    fun opened() {
        failures = 0
    }

    /** A socket ended (or never opened). [heldMs] is how long it was open, 0 when it never was. Answers how long to wait. */
    fun dropped(heldMs: Long): Long {
        if (heldMs >= STABLE_MS) {
            rung = FLOOR_MS
        }
        val ceiling = min(rung * 2, CAP_MS)
        val wait = rung
        rung = ceiling
        failures += 1
        return if (failures >= LONG_OUTAGE_ATTEMPTS) max(wait, LONG_OUTAGE_MS) else wait
    }

    fun failuresInARow(): Int = failures

    companion object {
        const val FLOOR_MS = 1_000L
        const val CAP_MS = 30_000L
        const val STABLE_MS = 60_000L
        const val LONG_OUTAGE_ATTEMPTS = 20
        const val LONG_OUTAGE_MS = 15 * 60_000L
    }
}
