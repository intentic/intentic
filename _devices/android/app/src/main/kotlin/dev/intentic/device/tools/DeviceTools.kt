package dev.intentic.device.tools

import dev.intentic.device.policy.Scopes
import dev.intentic.device.policy.Switch
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppAllowList
import dev.intentic.device.store.AppMode
import org.json.JSONObject
import java.util.Base64

/** `describe`: this phone, its switches, folders, allowed apps, battery and whether it is paused. */
class DescribeTool(private val facts: () -> JSONObject, private val scopes: () -> Scopes?) : Tool {
    override val name = "describe"
    override val description =
        "Which phone this is and what you may do on it: its Android version and battery, whether the person paused you, " +
            "which switches are on, the folders they picked (by the names to use as `folder`) and the apps they allowed you into. Call it first."
    override val inputSchema = Schemas.obj()
    override val effect = Effect.READ
    override val needs: Switch? = null

    override fun call(args: JSONObject): ToolResult = ToolResult.text(text(facts(), scopes()))

    companion object {
        fun text(facts: JSONObject, scopes: Scopes?): String {
            val lines = mutableListOf<String>()
            lines += "Phone: ${facts.optString("device")}, Android ${facts.optString("android")} (API ${facts.optInt("sdk")}), ${facts.optString("build")} build."
            lines += if (facts.optBoolean("paused")) "Paused: yes. The person paused the agent, so every other tool is refused until they resume it." else "Paused: no."
            facts.optJSONObject("battery")?.let {
                lines += "Battery: ${it.optInt("level")}%${if (it.optBoolean("charging")) ", charging" else ""}."
            }
            if (scopes == null) {
                lines += "Switches: not received from the sandbox yet, so every one counts as off."
            } else {
                lines += "Switches (from this phone's card in the sandbox): " +
                    Switch.entries.joinToString("; ") { "${it.label}: ${if (scopes.allows(it)) "on" else "off"}" } +
                    ". Ask on the phone first: ${scopes.confirm.key}."
            }
            val folders = facts.optJSONArray("folders")
            lines += if (folders == null || folders.length() == 0) {
                "Folders: none. The person picks them in the Intentic Device app."
            } else {
                "Folders: " + (0 until folders.length()).joinToString("; ") {
                    val folder = folders.getJSONObject(it)
                    "${folder.optString("name")} (${if (folder.optBoolean("writable")) "read and change" else "read only"})"
                } + "."
            }
            val apps = facts.optJSONArray("apps")
            lines += if (apps == null || apps.length() == 0) {
                "Apps you are allowed into: none. Use ask_access to ask the person."
            } else {
                "Apps you are allowed into: " + (0 until apps.length()).joinToString("; ") {
                    val app = apps.getJSONObject(it)
                    "${app.optString("label")} (${app.optString("package")}): ${app.optString("mode")}"
                } + "."
            }
            val access = facts.optJSONObject("access")
            lines += when (access?.optString("screenCapture")) {
                "accessibility" -> "Screen capture: through the touch service, with no prompt."
                "consent" -> "Screen capture: Android asks the person once per session."
                else -> "Screen capture: off on this phone."
            }
            lines += "Touch and type (accessibility service): ${if (access?.optBoolean("accessibility") == true) "on" else "off or not in this build"}."
            lines += "Notification access: ${if (access?.optBoolean("notifications") == true) "on" else "off"}."
            return lines.joinToString("\n")
        }
    }
}

/** `screenshot`: the screen as an image, through MediaProjection once the person approved a session. */
class ScreenshotTool(private val screen: ScreenPort, private val frames: FrameLog) : Tool {
    override val name = "screenshot"
    override val description =
        "A screenshot of the phone's screen, as an image with a frame id. Android makes the person approve screen sharing once per " +
            "session: if they have not yet, this asks on the phone and says it asked, and you call it again after they have. " +
            "A black image is a protected screen (a banking app, a password field)."
    override val inputSchema = Schemas.obj()
    override val effect = Effect.READ
    override val needs = Switch.SCREEN

    override fun call(args: JSONObject): ToolResult {
        val shot = screen.capture()
        if (shot == null) {
            screen.askToShare()
            return ToolResult.asked("Asked on the phone to share the screen; call screenshot again once they have.")
        }
        val frame = frames.record(shot.width, shot.height, shot.phoneWidth, shot.phoneHeight)
        return ToolResult(
            listOf(
                ToolResult.imageBlock(Base64.getEncoder().encodeToString(shot.jpeg), "image/jpeg"),
                ToolResult.textBlock(FrameMath.caption(frame)),
            ),
        )
    }
}

/** `open`: a link or an app, through a notification the person taps, since Android does not let a background service start one. */
class OpenTool(private val apps: AppsPort) : Tool {
    override val name = "open"
    override val description =
        "Open a link (http or https) or an app (by package name; `apps` lists them) on the phone. Android does not let a background " +
            "service start an app, so this shows a notification, \"Your agent wants to open ...\", and it opens when the person taps it. " +
            "Give either `url` or `app`."
    override val inputSchema = Schemas.obj(
        "url" to Schemas.string("An http or https link."),
        "app" to Schemas.string("An app's package name, for example com.android.chrome."),
    )
    override val effect = Effect.WRITE
    override val needs = Switch.APPS

    override fun call(args: JSONObject): ToolResult {
        val url = args.optString("url", "").trim()
        val pkg = args.optString("app", "").trim()
        if (url.isEmpty() == pkg.isEmpty()) {
            throw ToolFailed("Give either `url` (a link) or `app` (a package name), not both and not neither.")
        }
        if (url.isNotEmpty()) {
            val host = Links.hostOf(url) ?: throw ToolFailed("Only http and https links can be opened, and \"${url.take(80)}\" is not one.")
            apps.askToOpenLink(url)
            return ToolResult.asked("Asked on the phone to open $host: it opens when the person taps the notification, and not before.")
        }
        val app = apps.find(pkg) ?: throw ToolFailed("There is no launchable app \"$pkg\" on this phone. `apps` lists the ones there are.")
        apps.askToOpen(app)
        return ToolResult.asked("Asked on the phone to open ${app.label}: it opens when the person taps the notification, and not before.")
    }
}

object Links {
    private val web = Regex("^https?://([^\\s/?#@]+@)?([^\\s/?#:]+)(:[0-9]+)?([/?#]\\S*)?$", RegexOption.IGNORE_CASE)

    /** The host of an http or https link, or null for anything else (a `javascript:` or `intent:` link, a link with spaces). */
    fun hostOf(url: String): String? {
        if (url.length > 2000 || url.any { it.isISOControl() }) {
            return null
        }
        return web.matchEntire(url)?.groupValues?.get(2)
    }
}

/** `apps`: the launchable apps and what the person allowed in each. */
class AppsTool(private val apps: AppsPort, private val allowList: AppAllowList) : Tool {
    override val name = "apps"
    override val description =
        "The apps on the phone that can be launched, with their package names and what the person allowed you in each: " +
            "none, read (look) or act (look and touch)."
    override val inputSchema = Schemas.obj()
    override val effect = Effect.READ
    override val needs = Switch.APPS

    override fun call(args: JSONObject): ToolResult {
        val allowed = allowList.all().associateBy { it.pkg }
        val installed = apps.launchable().sortedBy { it.label.lowercase() }
        val shown = installed.take(MAX_APPS)
        val lines = shown.map { app -> "${app.label} (${app.pkg}): ${modeOf(allowed[app.pkg])}" }
        val more = if (installed.size > shown.size) "\n... and ${installed.size - shown.size} more." else ""
        return ToolResult.text("${installed.size} apps. What you may do in each: none, read or act.\n${lines.joinToString("\n")}$more")
    }

    private fun modeOf(app: AllowedApp?): String = if (app == null) "none" else app.mode.key + if (app.sensitive) " (sensitive)" else ""

    private companion object {
        const val MAX_APPS = 400
    }
}

/** `ask_access`: records the request and asks the person on the phone. Never grants. */
class AskAccessTool(private val apps: AppsPort, private val allowList: AppAllowList) : Tool {
    override val name = "ask_access"
    override val description =
        "Ask the person to let you into an app, to read it (look at it) or act in it (look and touch). This shows a notification on the " +
            "phone with Allow and Deny: only they can allow it and nothing changes until they do. Say in `reason` what you need it for, " +
            "then stop; `apps` shows their answer later."
    override val inputSchema = Schemas.obj(
        "app" to Schemas.string("The app's package name, from `apps`."),
        "mode" to Schemas.choice("read to look, act to look and touch.", "read", "act"),
        "reason" to Schemas.string("Why you need it, in a sentence the person will read."),
        required = listOf("app", "mode", "reason"),
    )
    override val effect = Effect.WRITE
    override val needs: Switch? = null

    override fun call(args: JSONObject): ToolResult {
        val pkg = args.getString("app").trim()
        val mode = AppMode.of(args.getString("mode")) ?: throw ToolFailed("`mode` is read or act.")
        val reason = args.getString("reason").trim().take(MAX_REASON)
        val app = apps.find(pkg) ?: throw ToolFailed("There is no launchable app \"$pkg\" on this phone. `apps` lists the ones there are.")
        val held = allowList.find(pkg)
        if (held != null && (held.mode == AppMode.ACT || mode == AppMode.READ)) {
            return ToolResult.text("The person already allowed you to ${held.mode.key} in ${app.label}; there is nothing to ask.")
        }
        val verb = if (mode == AppMode.READ) "read" else "act in"
        return when (apps.askAccess(app, mode, reason)) {
            AccessAsk.ASKED -> ToolResult.asked("Asked on the phone to let you $verb ${app.label}. Nothing changes until the person answers; call `apps` later to see whether they allowed it.")
            AccessAsk.ALREADY_WAITING -> ToolResult.asked("That request is already waiting on the phone for the person to answer. Do not ask again.")
            AccessAsk.DENIED_RECENTLY -> ToolResult.text("The person said no to this a moment ago. Do not ask again now; carry on without it or tell them what you could not do.", isError = true, outcome = "refused")
            AccessAsk.TOO_MANY -> throw ToolFailed("Several requests are already waiting on the phone. Ask the person to answer them first.")
        }
    }

    private companion object {
        const val MAX_REASON = 300
    }
}

/** `clipboard`: puts text on the clipboard. Android does not let an app read it back from the background. */
class ClipboardTool(private val clipboard: ClipboardPort) : Tool {
    override val name = "clipboard"
    override val description =
        "Put text on the phone's clipboard, for the person to paste. Android does not let an app read the clipboard back from the " +
            "background, so there is no way to read it."
    override val inputSchema = Schemas.obj("text" to Schemas.string("The text to copy."), required = listOf("text"))
    override val effect = Effect.WRITE
    override val needs = Switch.CONTROL

    override fun call(args: JSONObject): ToolResult {
        val text = args.getString("text")
        if (text.length > MAX_CHARS) {
            throw ToolFailed("That is ${text.length} characters; the clipboard takes at most $MAX_CHARS here.")
        }
        clipboard.put(text)
        return ToolResult.text("Put ${text.length} characters on the clipboard.")
    }

    private companion object {
        const val MAX_CHARS = 100_000
    }
}
