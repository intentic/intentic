package dev.intentic.app.web

import android.content.Context
import android.content.Intent
import android.util.Log
import dev.intentic.app.conversation.ConversationActivity
import dev.intentic.app.core.Calls
import dev.intentic.app.core.Request
import dev.intentic.app.ui.Looks
import dev.intentic.app.ui.MainActivity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** What the page tells the app, as `nativeApp.ts`'s NativeMessage, read off the JSON `intenticNative.postMessage` sends. */
sealed interface PageMessage {
    /** A screen the app draws: a conversation, the board, the menu, sign-in. */
    data class Open(val path: String) : PageMessage

    data object SignOut : PageMessage

    data class SetLook(val look: String) : PageMessage

    data class Routed(val path: String, val title: String, val canGoBack: Boolean) : PageMessage

    /** Words a page offered for a conversation's composer: the conversation opens with them in its draft, unsent. */
    data class Compose(val conversationId: String, val text: String) : PageMessage

    /** The app's own script reading a `blob:` download back (Downloads.kt), not the page's contract. */
    data class Download(val name: String, val mime: String, val data: String) : PageMessage

    companion object {
        /** Null for anything else: the page ships ahead of app builds, so a message this app does not know is not an error. */
        fun of(json: String): PageMessage? {
            val message = try {
                Json.parseToJsonElement(json).jsonObject
            } catch (error: IllegalArgumentException) {
                return null
            }
            fun text(key: String) = (message[key] as? JsonPrimitive)?.contentOrNull
            return when (text("kind")) {
                "open" -> text("path")?.let(::Open)
                "signOut" -> SignOut
                "setLook" -> text("look")?.let(::SetLook)
                "routed" -> Routed(text("path").orEmpty(), text("title").orEmpty(), message.flag("canGoBack"))
                "compose" -> text("conversationId")?.let { Compose(it, text("text").orEmpty()) }
                "download" -> text("data")?.let { Download(text("name").orEmpty().ifEmpty { "download" }, text("mime").orEmpty(), it) }
                else -> null
            }
        }

        private fun JsonObject.flag(key: String): Boolean = this[key]?.jsonPrimitive?.booleanOrNull ?: false
    }
}

/** Where a path the page hands over goes natively. */
enum class NativeScreen { CONVERSATION, HOME, NONE }

/** `/agents/<id>` a conversation; `/agents[?…]`, `/menu` and `/login…` the app's home, which shows sign-in when signed out. */
fun nativeScreenOf(path: String): Pair<NativeScreen, String?> {
    val route = path.substringBefore('?').substringBefore('#')
    val parts = route.trim('/').split('/').filter(String::isNotEmpty)
    return when {
        parts.size >= 2 && parts[0] == "agents" -> NativeScreen.CONVERSATION to decoded(parts[1])
        parts.firstOrNull() == "agents" || parts.firstOrNull() == "menu" || parts.firstOrNull() == "login" -> NativeScreen.HOME to null
        else -> NativeScreen.NONE to null
    }
}

// A path segment as the page escaped it (encodeURIComponent), read back: `+` is a plus there, never a space.
// (The charset by name: the Charset overload is API 33.)
private fun decoded(segment: String): String = java.net.URLDecoder.decode(segment.replace("+", "%2B"), "UTF-8")

/** Acts on what the page says, on the main thread. */
internal object Bridge {
    fun heard(json: String) {
        // A download carries its whole file; the preview's log gets its kind, not its bytes.
        WebHost.heard?.invoke(if (json.contains("\"kind\":\"download\"")) "{\"kind\":\"download\"}" else json)
        when (val message = PageMessage.of(json)) {
            is PageMessage.Routed -> {
                WebHost.up()
                WebHost.screen?.routed(message.path, message.title)
            }
            is PageMessage.Open -> open(message.path)
            PageMessage.SignOut -> {
                // After the web's own sign-out; the core may already be signed out, and asking again changes nothing.
                Calls.send(Request.SignOut)
                WebHost.forget()
                home()
            }
            is PageMessage.SetLook -> {
                val screen = WebHost.screen ?: return
                Looks.choose(message.look, screen.applicationContext)
                screen.recreate()
            }
            is PageMessage.Compose -> WebHost.screen?.let { it.startActivity(ConversationActivity.intent(it, message.conversationId, message.text)) }
            is PageMessage.Download -> WebHost.screen?.let { Downloads.save(it, message.name, message.mime, message.data) }
            null -> Log.d("WebHost", "a message this app does not know")
        }
    }

    fun open(path: String) {
        val context: Context = WebHost.screen ?: return
        val (screen, agent) = nativeScreenOf(path)
        when (screen) {
            NativeScreen.CONVERSATION -> context.startActivity(ConversationActivity.intent(context, agent))
            NativeScreen.HOME -> home()
            NativeScreen.NONE -> Unit
        }
    }

    // The app's own screens: MainActivity is singleTask, so starting it closes every screen above it.
    private fun home() {
        val context: Context = WebHost.screen ?: return
        context.startActivity(Intent(context, MainActivity::class.java))
    }
}
