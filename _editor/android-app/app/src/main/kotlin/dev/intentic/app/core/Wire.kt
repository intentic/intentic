package dev.intentic.app.core

import kotlinx.serialization.json.Json

/**
 * The JSON both sides of the bridge write. Rust tags its enums `#[serde(tag = "type", content = "content")]` and
 * typeshare turns each variant into a subclass holding one `content` property, so a discriminator named `type` is
 * all it takes for `Request.Ping(RequestPingInner("hi"))` to read `{"type":"Ping","content":{"echo":"hi"}}`.
 */
object Wire {
    private val json = Json { classDiscriminator = "type" }

    // Through the sealed parent's serializer: encoding a subclass by its own type would leave out the discriminator.
    fun encode(request: Request): String = json.encodeToString(Request.serializer(), request)

    fun encode(config: Config): String = json.encodeToString(Config.serializer(), config)

    fun decodeEvent(text: String): Event = json.decodeFromString(Event.serializer(), text)

    /** What `Core.card` answers: a card row's buttons' needs. */
    fun decodeCard(text: String): CardRow = json.decodeFromString(CardRow.serializer(), text)
}
