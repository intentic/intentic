package dev.intentic.device.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.autofill.AutofillManager
import android.widget.LinearLayout
import android.widget.Toast
import dev.intentic.device.Graph
import dev.intentic.device.passwords.PasswordsClient
import dev.intentic.device.passwords.PhoneKeys
import dev.intentic.device.store.Pairing
import org.json.JSONObject

/** "Passwords" rows on the main screen: computers from the sandbox, pairing, save target, autofill settings. */
object PasswordsSection {
    fun render(activity: Activity, ui: Ui, content: LinearLayout, pairing: Pairing, keyrings: List<PasswordsClient.Keyring>?, loading: Boolean, onRefresh: () -> Unit) {
        content.addView(ui.heading("Passwords"))
        content.addView(ui.body("Save sign-ins to your Passwords on a computer you trust, and fill them back after you confirm with your fingerprint or screen lock.", muted = true))
        val manager = activity.getSystemService(AutofillManager::class.java)
        if (manager != null && !manager.hasEnabledAutofillServices()) {
            content.addView(ui.action("Intentic is not your autofill app yet. Android needs that before it can offer to fill or save.", "Turn on") {
                activity.startActivity(
                    Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:${activity.packageName}")),
                )
            })
        } else if (manager != null && !manager.isAutofillSupported) {
            content.addView(ui.body("This Android version does not support autofill.", muted = true))
        }
        if (loading) {
            content.addView(ui.body("Loading your computers...", muted = true))
            return
        }
        if (keyrings == null) {
            content.addView(ui.action("Could not load your computers.", "Try again", onRefresh))
            return
        }
        Graph.passwords.rememberKeyrings(keyrings)
        if (keyrings.isEmpty()) {
            content.addView(ui.body("No computers with Passwords are reachable from this sandbox yet.", muted = true))
            return
        }
        val saveChoices = keyrings.filter { it.inbox != null && it.remember && it.online && !it.locked }
        if (saveChoices.isNotEmpty()) {
            content.addView(ui.body("Save passwords to"))
            val current = Graph.passwords.settings.saveToKeyring ?: saveChoices.first().device
            for (choice in saveChoices) {
                val mark = if (choice.device == current) " ✓" else ""
                content.addView(ui.button("${choice.label}$mark") {
                    Graph.passwords.settings.saveToKeyring = choice.device
                    Graph.changes.fire()
                })
            }
        }
        for (row in keyrings) {
            val status = buildString {
                append(row.label)
                append(" — ")
                append(
                    when {
                        !row.online -> "offline"
                        row.locked == true -> "locked"
                        row.paired -> "paired"
                        else -> "not paired"
                    },
                )
                if (row.remember) append(", remembering from this phone")
            }
            content.addView(ui.body(status))
            if (row.online && row.inbox != null) {
                content.addView(ui.button(if (row.paired) "Pair again" else "Pair") {
                    pair(activity, pairing, row, onRefresh)
                })
                Graph.passwords.settings.pairedFingerprint(row.device)?.let { fp ->
                    content.addView(ui.mono("Your computer shows: $fp"))
                }
            }
        }
    }

    private fun pair(activity: Activity, pairing: Pairing, row: PasswordsClient.Keyring, onRefresh: () -> Unit) {
        Thread({
            val keys = Graph.passwords.phoneKeys.load(activity, pairing.id, android.os.Build.MODEL)
            val phone = JSONObject()
                .put("device", keys.deviceId)
                .put("label", keys.label)
                .put("seal", keys.seal.publicKey)
                .put("presence", keys.presenceSpkiBase64)
            when (val result = Graph.passwords.client.pair(pairing, row.device, phone)) {
                is PasswordsClient.Result.Ok -> {
                    Graph.passwords.settings.setPaired(row.device, true)
                    Graph.passwords.settings.setPairedFingerprint(row.device, result.value.keyringFingerprint)
                    if (Graph.passwords.settings.saveToKeyring == null && row.remember) {
                        Graph.passwords.settings.saveToKeyring = row.device
                    }
                    activity.runOnUiThread {
                        Toast.makeText(
                            activity,
                            "Check that your computer shows ${PhoneKeys.sealFingerprint(keys.seal.publicKey)}",
                            Toast.LENGTH_LONG,
                        ).show()
                        onRefresh()
                    }
                }
                is PasswordsClient.Result.Refused -> activity.runOnUiThread {
                    Toast.makeText(activity, result.message, Toast.LENGTH_LONG).show()
                }
            }
        }, "intentic-pair-passwords").start()
    }
}
