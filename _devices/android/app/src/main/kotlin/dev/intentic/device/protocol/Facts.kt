package dev.intentic.device.protocol

import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.Folder
import org.json.JSONArray
import org.json.JSONObject

data class Battery(val level: Int, val charging: Boolean)

/** What the phone knows about itself, before it becomes the JSON of PhoneFacts (_shared/sandbox-contract/src/schemas/phone.ts). */
data class PhoneSnapshot(
    /** How a person names it: "Google Pixel 8". */
    val device: String,
    val androidRelease: String,
    val sdk: Int,
    /** "direct" or "play". */
    val build: String,
    val paused: Boolean,
    val accessibility: Boolean,
    val notifications: Boolean,
    /** How a screenshot is taken now: "accessibility" (no prompt), "consent" (the person allows each session) or "none". */
    val screenCapture: String,
    val folders: List<Folder>,
    val apps: List<AllowedApp>,
    val battery: Battery?,
    /** The Firebase token, when Firebase is configured and Google Play services gave one; absent otherwise. */
    val fcmToken: String?,
    val features: List<String>,
)

object FactsJson {
    fun of(snapshot: PhoneSnapshot): JSONObject {
        val facts = JSONObject()
            .put("device", snapshot.device)
            .put("android", snapshot.androidRelease)
            .put("sdk", snapshot.sdk)
            .put("build", snapshot.build)
            .put("paused", snapshot.paused)
            .put(
                "access",
                JSONObject()
                    .put("accessibility", snapshot.accessibility)
                    .put("notifications", snapshot.notifications)
                    .put("screenCapture", snapshot.screenCapture),
            )
            .put("folders", JSONArray(snapshot.folders.map { JSONObject().put("name", it.name).put("writable", it.writable) }))
            .put("apps", JSONArray(snapshot.apps.map { JSONObject().put("package", it.pkg).put("label", it.label).put("mode", it.mode.key) }))
        snapshot.battery?.let { facts.put("battery", JSONObject().put("level", it.level.coerceIn(0, 100)).put("charging", it.charging)) }
        if (!snapshot.fcmToken.isNullOrEmpty()) {
            facts.put("wake", JSONObject().put("fcm", snapshot.fcmToken))
        }
        if (snapshot.features.isNotEmpty()) {
            facts.put("features", JSONArray(snapshot.features))
        }
        return facts
    }
}
