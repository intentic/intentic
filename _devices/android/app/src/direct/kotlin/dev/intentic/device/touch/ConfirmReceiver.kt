package dev.intentic.device.touch

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The person's Allow or Deny on a heads-up question from the agent. Not exported: only the system, delivering a tap on the
 * notification's own button, reaches it, and an answer to a question that is no longer waiting changes nothing.
 */
class ConfirmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_ID, -1)
        if (id < 0) {
            return
        }
        TouchRuntime.confirmations.answer(id, intent.action == ACTION_ALLOW)
    }

    companion object {
        const val ACTION_ALLOW = "dev.intentic.device.CONFIRM_ALLOW"
        const val ACTION_DENY = "dev.intentic.device.CONFIRM_DENY"
        const val EXTRA_ID = "id"
    }
}
