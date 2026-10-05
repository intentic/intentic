package dev.intentic.device.update

import org.json.JSONException
import org.json.JSONObject

/** A release as `intentic-device.json` says it: the version, where its APK is, and the APK's SHA-256. */
data class Release(val version: String, val url: String, val sha256: String)

object UpdateManifest {
    const val URL = "https://github.com/intentic/intentic/releases/latest/download/intentic-device.json"

    /** The release the manifest names, or null when it is not a manifest this app can trust: no version, a url that is not https, a digest that is not 64 hex characters. */
    fun parse(text: String): Release? =
        try {
            val json = JSONObject(text)
            val version = (json.opt("version") as? String)?.trim().orEmpty()
            val url = (json.opt("url") as? String)?.trim().orEmpty()
            val sha256 = (json.opt("sha256") as? String)?.trim()?.lowercase().orEmpty()
            if (version.isEmpty() || !url.startsWith("https://") || !Regex("^[0-9a-f]{64}$").matches(sha256)) null else Release(version, url, sha256)
        } catch (error: JSONException) {
            null
        }

    /**
     * Whether [candidate] is a later version than [current]. Dotted numbers compare by value ("0.10.0" is later than "0.9.0"), a
     * leading "v" is ignored, and a pre-release ("1.0.0-rc1") is earlier than its release.
     */
    fun isNewer(candidate: String, current: String): Boolean {
        val (candidateCore, candidatePre) = split(candidate)
        val (currentCore, currentPre) = split(current)
        for (index in 0 until maxOf(candidateCore.size, currentCore.size)) {
            val a = candidateCore.getOrElse(index) { 0 }
            val b = currentCore.getOrElse(index) { 0 }
            if (a != b) {
                return a > b
            }
        }
        return when {
            candidatePre == null -> currentPre != null
            currentPre == null -> false
            else -> candidatePre > currentPre
        }
    }

    private fun split(version: String): Pair<List<Long>, String?> {
        val trimmed = version.trim().removePrefix("v").removePrefix("V")
        val core = trimmed.substringBefore('-').substringBefore('+')
        val pre = if (trimmed.contains('-')) trimmed.substringAfter('-').substringBefore('+') else null
        return core.split('.').map { it.toLongOrNull() ?: 0L } to pre
    }
}
