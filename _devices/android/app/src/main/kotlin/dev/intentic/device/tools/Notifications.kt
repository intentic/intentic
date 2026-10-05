package dev.intentic.device.tools

import dev.intentic.device.policy.Switch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One notification as the agent is shown it: who posted it, what it says, when. */
data class NoticeRecord(
    val key: String,
    val pkg: String,
    val label: String,
    val title: String,
    val text: String,
    val time: Long,
    val category: String?,
)

/** Whether notification access is on, and what it has seen. The Android listener fills [NoticeLog]; the tool reads it. */
interface NoticesPort {
    /** The notification listener is bound: the person switched notification access on and Android connected it. */
    fun enabled(): Boolean

    /** Newest first, at most [limit], optionally only those of the app whose package equals or whose label contains [app]. */
    fun recent(limit: Int, app: String?): List<Shown>
}

/** A notification in an answer, with whether it is still in the shade. */
data class Shown(val record: NoticeRecord, val showing: Boolean)

/**
 * What the notification listener has seen: the notifications showing now, and a ring of the last [capacity] posted since it
 * connected (a chat app that updates one notification fills the ring with its updates). This app's own notifications are
 * never recorded: they are what the agent's own requests look like, and the person's consent prompts are not for it to read.
 */
class NoticeLog(private val ownPackage: String, private val capacity: Int = CAPACITY) {
    private val posted = ArrayDeque<NoticeRecord>()
    private val active = LinkedHashMap<String, NoticeRecord>()

    @Volatile
    var connected: Boolean = false
        private set

    /** The listener connected: what is showing becomes the starting point, and the ring starts empty. */
    @Synchronized
    fun connect(showing: List<NoticeRecord>) {
        posted.clear()
        active.clear()
        showing.filter { it.pkg != ownPackage }.forEach { active[it.key] = it }
        connected = true
    }

    @Synchronized
    fun disconnect() {
        connected = false
        active.clear()
    }

    @Synchronized
    fun posted(record: NoticeRecord) {
        if (record.pkg == ownPackage) {
            return
        }
        active[record.key] = record
        posted.addLast(record)
        while (posted.size > capacity) {
            posted.removeFirst()
        }
    }

    @Synchronized
    fun removed(key: String) {
        active.remove(key)
    }

    /** The ring itself, oldest first: what was posted since connecting, up to the capacity. */
    @Synchronized
    fun history(): List<NoticeRecord> = posted.toList()

    /** Showing now plus posted since connecting, newest first, each notification once. */
    @Synchronized
    fun recent(limit: Int, app: String?): List<Shown> {
        val wanted = app?.trim()?.lowercase().orEmpty()
        val everything = LinkedHashMap<String, Shown>()
        for (record in posted) {
            everything["${record.key}@${record.time}"] = Shown(record, showing = active[record.key]?.time == record.time)
        }
        for (record in active.values) {
            everything["${record.key}@${record.time}"] = Shown(record, showing = true)
        }
        return everything.values
            .filter { wanted.isEmpty() || it.record.pkg.lowercase() == wanted || it.record.label.lowercase().contains(wanted) }
            .sortedByDescending { it.record.time }
            .take(limit.coerceIn(1, MAX_LIMIT))
    }

    companion object {
        const val CAPACITY = 200
        const val DEFAULT_LIMIT = 20
        const val MAX_LIMIT = 100
    }
}

/** `notifications`: what the phone's notifications say, which is where codes and messages arrive. */
class NotificationsTool(private val notices: NoticesPort) : Tool {
    override val name = "notifications"
    override val description =
        "The phone's recent notifications, newest first: the ones showing now and those posted since notification access connected " +
            "(one-time codes, messages, deliveries). Each has its app, title, text, time and category. Cheaper than opening an app, and it " +
            "does not move what the person is looking at. `limit` defaults to 20, at most 100; `app` keeps only one app's (its package, " +
            "or part of its name). Needs notification access switched on in Android's settings."
    override val inputSchema = Schemas.obj(
        "limit" to Schemas.integer("How many, newest first. Default 20, at most 100."),
        "app" to Schemas.string("Only this app's notifications: its package name, or part of its name."),
    )
    override val effect = Effect.READ
    override val needs = Switch.NOTIFICATIONS

    override fun call(args: JSONObject): ToolResult {
        if (!notices.enabled()) {
            throw ToolRefused(
                "Refused: notification access is not switched on for Intentic Device in Android's settings, so no notification can be read. " +
                    "The person switches it on from \"Access on this phone\" in the app.",
            )
        }
        val limit = if (args.has("limit") && !args.isNull("limit")) args.getInt("limit") else NoticeLog.DEFAULT_LIMIT
        val app = if (args.has("app") && !args.isNull("app")) args.getString("app") else null
        val shown = notices.recent(limit.coerceIn(1, NoticeLog.MAX_LIMIT), app)
        if (shown.isEmpty()) {
            return ToolResult.text(if (app == null) "No notifications have arrived since notification access connected." else "No notifications from \"$app\".")
        }
        val format = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT)
        val lines = shown.map { (record, showing) ->
            val title = if (record.title.isBlank()) "" else " \"${cut(record.title)}\""
            val body = if (record.text.isBlank()) "" else ": ${cut(record.text)}"
            val state = listOfNotNull(if (showing) "showing" else null, record.category).joinToString(", ")
            "[${format.format(Date(record.time))}] ${record.label} (${record.pkg})$title$body${if (state.isEmpty()) "" else " [$state]"}"
        }
        return ToolResult.text("${shown.size} notifications, newest first.\n${lines.joinToString("\n")}")
    }

    private fun cut(text: String): String {
        val oneLine = text.replace(Regex("\\s+"), " ").trim()
        return if (oneLine.length <= MAX_FIELD) oneLine else oneLine.take(MAX_FIELD) + "..."
    }

    private companion object {
        const val MAX_FIELD = 400
    }
}

/** [NoticesPort] over what the Android listener recorded. */
class LogNotices(private val log: NoticeLog) : NoticesPort {
    override fun enabled(): Boolean = log.connected

    override fun recent(limit: Int, app: String?): List<Shown> = log.recent(limit, app)
}
