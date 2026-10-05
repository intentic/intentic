package dev.intentic.device.protocol

import org.json.JSONException
import org.json.JSONObject

/** What the sandbox answered when the phone redeemed its one-time pairing at POST /system/phones/enroll. */
sealed interface EnrollResult {
    /** The durable pairing: [id] is the phone's capability card, [token] what the hello frame carries from now on. */
    data class Enrolled(val id: String, val token: String) : EnrollResult

    /** A sentence for the owner: the sandbox's own reason when it gave one. */
    data class Refused(val message: String) : EnrollResult
}

object Enrollment {
    fun interpret(status: Int, body: String): EnrollResult {
        val json = try {
            JSONObject(body)
        } catch (ignored: JSONException) {
            null
        }
        if (status == 200) {
            val id = json?.opt("id") as? String
            val token = json?.opt("token") as? String
            return if (id.isNullOrEmpty() || token.isNullOrEmpty()) {
                EnrollResult.Refused("The sandbox answered, but not with a pairing this app can read. Is the app out of date?")
            } else {
                EnrollResult.Enrolled(id, token)
            }
        }
        val said = json?.opt("error") as? String
        if (status == 401) {
            return EnrollResult.Refused(said ?: "The sandbox refused this pairing code. It may have expired or been used already.")
        }
        return EnrollResult.Refused(said ?: "The sandbox answered with HTTP $status.")
    }
}
