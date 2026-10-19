package dev.intentic.device.passwords

import dev.intentic.device.link.OkHttpSockets
import dev.intentic.device.store.Pairing
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** HTTPS to the sandbox's phone Passwords endpoints (`phone-passwords.ts`), authorised by the enrollment token. */
class PasswordsClient {
    private val json = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpSockets.client().newBuilder()
        .callTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val fillHttp = OkHttpSockets.client().newBuilder()
        .callTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    data class Keyring(
        val device: String,
        val label: String,
        val online: Boolean,
        val locked: Boolean,
        val inbox: String?,
        val remember: Boolean,
        val paired: Boolean,
    )

    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        data class Refused(val message: String) : Result<Nothing>
    }

    fun listKeyrings(pairing: Pairing): Result<List<Keyring>> = get(pairing, PATH_KEYRINGS) { body ->
        val array = JSONObject(body).getJSONArray("keyrings")
        (0 until array.length()).map { index ->
            val row = array.getJSONObject(index)
            Keyring(
                device = row.getString("device"),
                label = row.getString("label"),
                online = row.getBoolean("online"),
                locked = row.optBoolean("locked", false),
                inbox = row.optString("inbox", null)?.takeIf { it.isNotEmpty() },
                remember = row.getBoolean("remember"),
                paired = row.getBoolean("paired"),
            )
        }
    }

    fun pair(pairing: Pairing, keyringDevice: String, phone: JSONObject): Result<PairFingerprint> =
        post(pairing, PATH_PAIR, JSONObject().put("keyring", keyringDevice).put("phone", phone)) { body ->
            val json = JSONObject(body)
            if (!json.optBoolean("ok", false)) {
                throw Refusal(json.optString("refusal", "The computer refused pairing."))
            }
            PairFingerprint(json.getString("fingerprint"))
        }

    fun capture(pairing: Pairing, keyringDevice: String, item: JSONObject): Result<CaptureOutcome> =
        post(pairing, PATH_CAPTURE, JSONObject().put("keyring", keyringDevice).put("item", item)) { body ->
            val json = JSONObject(body)
            if (!json.optBoolean("ok", false)) {
                throw Refusal(json.optString("refusal", "The computer did not save that password."))
            }
            CaptureOutcome(json.getString("outcome"), json.optString("title", null))
        }

    fun fill(pairing: Pairing, keyringDevice: String, signed: JSONObject): Result<FillAnswer> =
        postFill(pairing, PATH_FILL, JSONObject().put("keyring", keyringDevice).put("fill", signed)) { body ->
            val json = JSONObject(body)
            if (!json.optBoolean("ok", false)) {
                throw Refusal(json.optString("refusal", "The computer did not fill that sign-in."))
            }
            FillAnswer(
                username = json.optString("username", null)?.takeIf { it.isNotEmpty() },
                sealed = Seal.Box(
                    v = json.getJSONObject("sealed").getInt("v"),
                    epk = json.getJSONObject("sealed").getString("epk"),
                    iv = json.getJSONObject("sealed").getString("iv"),
                    tag = json.getJSONObject("sealed").getString("tag"),
                    data = json.getJSONObject("sealed").getString("data"),
                ),
                title = json.getString("title"),
            )
        }

    data class PairFingerprint(val keyringFingerprint: String)
    data class CaptureOutcome(val outcome: String, val title: String?)
    data class FillAnswer(val username: String?, val sealed: Seal.Box, val title: String)

    private class Refusal(message: String) : Exception(message)

    private fun <T> get(pairing: Pairing, path: String, parse: (String) -> T): Result<T> = call(http, pairing, path, null, parse)

    private fun <T> post(pairing: Pairing, path: String, body: JSONObject, parse: (String) -> T): Result<T> =
        call(http, pairing, path, body, parse)

    private fun <T> postFill(pairing: Pairing, path: String, body: JSONObject, parse: (String) -> T): Result<T> =
        call(fillHttp, pairing, path, body, parse)

    private fun <T> call(client: okhttp3.OkHttpClient, pairing: Pairing, path: String, body: JSONObject?, parse: (String) -> T): Result<T> {
        val url = pairing.sandboxUrl.trimEnd('/') + path
        val builder = Request.Builder().url(url).header("Authorization", "Bearer ${pairing.token}")
        if (body != null) {
            builder.post(body.toString().toRequestBody(json))
        } else {
            builder.get()
        }
        return try {
            client.newCall(builder.build()).execute().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful) {
                    val said = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    Result.Refused(said ?: "The sandbox answered with HTTP ${response.code}.")
                } else {
                    Result.Ok(parse(text))
                }
            }
        } catch (error: Refusal) {
            Result.Refused(error.message ?: "Refused.")
        } catch (error: IOException) {
            Result.Refused("Could not reach your sandbox: ${error.message ?: "no answer"}.")
        }
    }

    companion object {
        const val PATH_KEYRINGS = "/system/phones/passwords/keyrings"
        const val PATH_PAIR = "/system/phones/passwords/pair"
        const val PATH_CAPTURE = "/system/phones/passwords/capture"
        const val PATH_FILL = "/system/phones/passwords/fill"
    }
}
