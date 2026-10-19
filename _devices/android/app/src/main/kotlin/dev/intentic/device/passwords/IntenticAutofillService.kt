package dev.intentic.device.passwords

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.Toast
import dev.intentic.device.Graph
import dev.intentic.device.R
import org.json.JSONObject

/** Android's autofill hook: offer to fill from the owner's Passwords on a paired computer, and to save new sign-ins. */
class IntenticAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: android.os.CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val parsed = parseStructure(structure)
        if (parsed.skip || parsed.passwordId == null) {
            return callback.onSuccess(null)
        }
        val pairing = Graph.pairings.get() ?: return callback.onSuccess(null)
        val keyring = Graph.passwords.settings.saveToKeyring ?: Graph.passwords.defaultSaveTarget()
        if (keyring == null || !Graph.passwords.settings.isPaired(keyring)) {
            return callback.onSuccess(null)
        }
        val authIntent = PasswordsAuthActivity.intent(this, keyring, parsed.origin, parsed.usernameId, parsed.passwordId)
        val pending = PendingIntent.getActivity(
            this,
            parsed.passwordId.hashCode(),
            authIntent,
            PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val presentation = RemoteViews(packageName, R.layout.autofill_chip).apply {
            setTextViewText(R.id.autofill_label, "Fill with Intentic")
        }
        val dataset = Dataset.Builder(presentation)
            .setAuthentication(pending.intentSender)
            .build()
        val saveIds = buildList {
            parsed.usernameId?.let { add(it) }
            parsed.passwordId?.let { add(it) }
        }.toTypedArray()
        val saveInfo = if (saveIds.isNotEmpty()) {
            SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_USERNAME or SaveInfo.SAVE_DATA_TYPE_PASSWORD, saveIds).build()
        } else {
            null
        }
        val responseBuilder = FillResponse.Builder().addDataset(dataset)
        if (saveInfo != null) {
            responseBuilder.setSaveInfo(saveInfo)
        }
        callback.onSuccess(responseBuilder.build())
    }

    override fun onSaveRequest(request: SaveRequest, cancellationSignal: android.os.CancellationSignal, callback: SaveCallback) {
        val pairing = Graph.pairings.get()
        if (pairing == null) {
            callback.onFailure("Pair this phone first.")
            return
        }
        val keyringDevice = Graph.passwords.settings.saveToKeyring ?: Graph.passwords.defaultSaveTarget()
        val inbox = Graph.passwords.inboxKey(keyringDevice)
        if (keyringDevice == null || inbox == null) {
            Toast.makeText(this, "No computer is ready to save passwords.", Toast.LENGTH_LONG).show()
            callback.onFailure("No computer ready.")
            return
        }
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onFailure("Nothing to save.")
        val parsed = parseStructure(structure)
        val client = request.clientState
        var password = client?.getCharSequence("password")?.toString()
        var username = client?.getCharSequence("username")?.toString()
        if (password.isNullOrEmpty()) {
            password = readValue(structure, parsed.passwordId)
        }
        if (username.isNullOrEmpty()) {
            username = readValue(structure, parsed.usernameId)
        }
        if (password.isNullOrEmpty()) {
            return callback.onFailure("No password to save.")
        }
        val keys = Graph.passwords.phoneKeys.load(this, pairing.id, android.os.Build.MODEL)
        val at = System.currentTimeMillis()
        val via = keys.label
        val sealed = Seal.sealRandom(inbox, password, Seal.captureAad(via, at))
        val item = JSONObject()
            .put("origin", parsed.origin)
            .apply { if (!username.isNullOrBlank()) put("username", username) }
            .put("sealed", sealed.toJson())
            .put("source", "phone")
            .put("via", via)
            .put("kind", "password")
            .put("at", at)
        Thread({
            when (val result = Graph.passwords.client.capture(pairing, keyringDevice, item)) {
                is PasswordsClient.Result.Ok -> callback.onSuccess()
                is PasswordsClient.Result.Refused -> callback.onFailure(result.message)
            }
        }, "intentic-save").start()
    }

    private data class StructureParsed(
        val origin: JSONObject,
        val usernameId: AutofillId?,
        val passwordId: AutofillId?,
        val skip: Boolean,
    )

    private fun parseStructure(structure: AssistStructure): StructureParsed {
        val fields = mutableListOf<Pair<String, AutofillFields.Hint>>()
        for (index in 0 until structure.childCount) {
            collect(structure.getChildAt(index), fields, structure.activityComponent.packageName)
        }
        val parsed = AutofillFields.parse(fields)
        val ids = mutableMapOf<String, AutofillId>()
        walkIds(structure) { id, nodeId ->
            ids[nodeId] = id
        }
        return StructureParsed(
            origin = parsed.origin,
            usernameId = parsed.usernameId?.let { ids[it] },
            passwordId = parsed.passwordId?.let { ids[it] },
            skip = parsed.skip,
        )
    }

    private fun walkIds(structure: AssistStructure, visit: (AutofillId, String) -> Unit) {
        fun walk(node: AssistStructure.ViewNode) {
            val autofillId = node.autofillId
            val key = node.idEntry ?: node.autofillId?.toString()
            if (autofillId != null && key != null) {
                visit(autofillId, key)
            }
            for (index in 0 until node.childCount) {
                walk(node.getChildAt(index))
            }
        }
        for (index in 0 until structure.childCount) {
            walk(structure.getChildAt(index))
        }
    }

    private fun readValue(structure: AssistStructure, id: AutofillId?): String? {
        if (id == null) {
            return null
        }
        var found: String? = null
        fun walk(node: AssistStructure.ViewNode) {
            if (found != null) {
                return
            }
            if (node.autofillId == id) {
                found = node.autofillValue?.textValue?.toString()
                return
            }
            for (index in 0 until node.childCount) {
                walk(node.getChildAt(index))
            }
        }
        for (index in 0 until structure.childCount) {
            walk(structure.getChildAt(index))
        }
        return found
    }

    private fun collect(node: AssistStructure.ViewNode, out: MutableList<Pair<String, AutofillFields.Hint>>, packageName: String) {
        val id = node.idEntry ?: node.autofillId?.toString() ?: return
        val hints = node.autofillHints?.toList() ?: emptyList()
        out += id to AutofillFields.Hint(
            autofillHints = hints,
            inputType = node.inputType,
            idEntry = node.idEntry,
            hint = node.hint,
            webDomain = node.webDomain,
            packageName = packageName,
        )
        for (index in 0 until node.childCount) {
            collect(node.getChildAt(index), out, packageName)
        }
    }
}
