package dev.intentic.device

import dev.intentic.device.link.LinkHost
import dev.intentic.device.link.LinkSocket
import dev.intentic.device.link.LinkSocketFactory
import dev.intentic.device.link.LinkSocketListener
import dev.intentic.device.link.LinkState
import dev.intentic.device.link.Scheduler
import dev.intentic.device.link.Timer
import dev.intentic.device.policy.Gate
import dev.intentic.device.policy.ScopeStore
import dev.intentic.device.protocol.Battery
import dev.intentic.device.protocol.FactsJson
import dev.intentic.device.protocol.JsonRpcPeer
import dev.intentic.device.protocol.McpServer
import dev.intentic.device.protocol.PhonePeer
import dev.intentic.device.protocol.PhoneSnapshot
import dev.intentic.device.protocol.ToolAudit
import dev.intentic.device.store.AccessRequests
import dev.intentic.device.store.AppAllowList
import dev.intentic.device.store.AppMode
import dev.intentic.device.store.Folder
import dev.intentic.device.store.FolderStore
import dev.intentic.device.store.KeyValue
import dev.intentic.device.store.LinkMode
import dev.intentic.device.store.Pairing
import dev.intentic.device.store.Settings
import dev.intentic.device.tools.AccessAsk
import dev.intentic.device.tools.AppsPort
import dev.intentic.device.tools.ClipboardPort
import dev.intentic.device.tools.FileEntry
import dev.intentic.device.tools.FilesPort
import dev.intentic.device.tools.FrameLog
import dev.intentic.device.tools.InstalledApp
import dev.intentic.device.tools.LogNotices
import dev.intentic.device.tools.NoticeLog
import dev.intentic.device.tools.Registry
import dev.intentic.device.tools.ScreenPort
import dev.intentic.device.tools.Shot
import dev.intentic.device.tools.Tool
import dev.intentic.device.tools.ToolDeps
import dev.intentic.device.tools.ToolFailed
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.Executor

class MemoryKv : KeyValue {
    private val map = HashMap<String, Any>()
    override fun getString(key: String): String? = map[key] as String?
    override fun putString(key: String, value: String?) {
        if (value == null) map.remove(key) else map[key] = value
    }
    override fun getBoolean(key: String, default: Boolean): Boolean = map[key] as Boolean? ?: default
    override fun putBoolean(key: String, value: Boolean) {
        map[key] = value
    }
    override fun getLong(key: String, default: Long): Long = map[key] as Long? ?: default
    override fun putLong(key: String, value: Long) {
        map[key] = value
    }
}

class FakeScreen : ScreenPort {
    var shot: Shot? = null
    var asked = 0
    override fun capture(): Shot? = shot
    override fun askToShare() {
        asked += 1
    }
}

class FakeApps : AppsPort {
    val installed = mutableListOf(InstalledApp("com.android.chrome", "Chrome"), InstalledApp("org.example.notes", "Notes"))
    val opened = mutableListOf<String>()
    val asks = mutableListOf<Triple<String, AppMode, String>>()
    var askOutcome = AccessAsk.ASKED
    override fun launchable(): List<InstalledApp> = installed
    override fun find(pkg: String): InstalledApp? = installed.firstOrNull { it.pkg == pkg }
    override fun askToOpen(app: InstalledApp) {
        opened += "app:${app.pkg}"
    }
    override fun askToOpenLink(url: String) {
        opened += "link:$url"
    }
    override fun askAccess(app: InstalledApp, mode: AppMode, reason: String): AccessAsk {
        asks += Triple(app.pkg, mode, reason)
        return askOutcome
    }
}

class FakeClipboard : ClipboardPort {
    var text: String? = null
    override fun put(text: String) {
        this.text = text
    }
}

/** A tree of files in memory: a path of names to its content, with folders implied by their children. */
class FakeFiles : FilesPort {
    val content = LinkedHashMap<String, ByteArray>()
    val trashed = mutableListOf<String>()

    private fun key(path: List<String>) = path.joinToString("/")

    override fun list(folder: Folder, path: List<String>): List<FileEntry> {
        val prefix = if (path.isEmpty()) "" else key(path) + "/"
        val children = content.keys.filter { it.startsWith(prefix) }.map { it.removePrefix(prefix) }
        val names = children.map { it.substringBefore('/') }.distinct()
        return names.map { name ->
            val isDir = children.any { it.startsWith("$name/") }
            FileEntry(name, isDir, if (isDir) 0 else content.getValue(prefix + name).size.toLong(), 0, if (isDir) null else "text/plain")
        }
    }

    override fun stat(folder: Folder, path: List<String>): FileEntry? {
        if (path.isEmpty()) return FileEntry(folder.name, true, 0, 0, null)
        val k = key(path)
        content[k]?.let { return FileEntry(path.last(), false, it.size.toLong(), 0, "text/plain") }
        return if (content.keys.any { it.startsWith("$k/") }) FileEntry(path.last(), true, 0, 0, null) else null
    }

    override fun open(folder: Folder, path: List<String>): InputStream =
        ByteArrayInputStream(content[key(path)] ?: throw ToolFailed("no such file"))

    override fun write(folder: Folder, path: List<String>, data: ByteArray) {
        content[key(path)] = data
    }

    override fun trash(folder: Folder, path: List<String>): String {
        content.remove(key(path))
        trashed += key(path)
        return ".intentic-trash"
    }
}

class RecordingAudit : ToolAudit {
    val entries = mutableListOf<Triple<String, JSONObject, String>>()
    override fun record(tool: String, args: JSONObject, outcome: String) {
        entries += Triple(tool, args, outcome)
    }
}

/**
 * The whole phone side of the protocol, assembled from fakes: what a unit test talks to as the sandbox would. [extra] builds the
 * tools a build flavor adds, from the same parts the common tools use.
 */
class FakePhone(extra: (ToolDeps) -> List<Tool> = { emptyList() }) {
    val kv = MemoryKv()
    val settings = Settings(kv)
    val scopes = ScopeStore(kv)
    val folders = FolderStore(kv)
    val allowList = AppAllowList(kv)
    val requests = AccessRequests(kv)
    val screen = FakeScreen()
    val apps = FakeApps()
    val clipboard = FakeClipboard()
    val files = FakeFiles()
    val frames = FrameLog()
    val noticeLog = NoticeLog("dev.intentic.device")
    val audit = RecordingAudit()
    var noticeVisible = true
    var toolCalls = 0

    val facts: () -> JSONObject = {
        FactsJson.of(
            PhoneSnapshot(
                device = "Google Pixel 8", androidRelease = "16", sdk = 36, build = "direct", paused = settings.paused,
                accessibility = false, notifications = false, screenCapture = "consent",
                folders = folders.all(), apps = allowList.all(), battery = Battery(81, false), fcmToken = null,
                features = listOf("screenshot", "files", "apps", "clipboard", "notifications"),
            ),
        )
    }

    val deps = ToolDeps(facts, scopes::current, screen, frames, apps, allowList, folders, files, clipboard, LogNotices(noticeLog))
    val tools: List<Tool> = Registry.tools(deps, extra(deps))
    val gate = Gate(scopes::current, { settings.paused }, { noticeVisible })
    val mcp = McpServer(tools, gate, audit, "0.1.0") { toolCalls += 1 }
    val rpc = JsonRpcPeer(PhonePeer(facts, scopes, mcp))

    private var nextId = 0

    /** One request frame answered, as the sandbox's JSON-RPC link would read it. */
    fun call(method: String, params: Any? = null): JSONObject {
        val frame = JSONObject().put("jsonrpc", "2.0").put("id", nextId++).put("method", method)
        if (params != null) frame.put("params", params)
        return JSONObject(rpc.handle(frame.toString())!!)
    }

    /** The result of one MCP message carried in an `mcp` request, unwrapped to the MCP response object. */
    fun mcpCall(method: String, params: JSONObject? = null, id: Any = "t"): JSONObject {
        val message = JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method)
        if (params != null) message.put("params", params)
        return call("mcp", message).getJSONObject("result")
    }

    fun toolCall(name: String, args: JSONObject = JSONObject()): JSONObject =
        mcpCall("tools/call", JSONObject().put("name", name).put("arguments", args)).getJSONObject("result")

    fun grant(vararg on: String, confirm: String = "sensitive") {
        val params = JSONObject().put("platform", "android").put("confirm", confirm)
        for (key in listOf("screen", "control", "files", "write", "notifications", "apps", "destructive")) {
            params.put(key, if (key in on) "on" else "off")
        }
        call("setScopes", params)
    }
}

/** Virtual time for the link controller: tasks run in time order, one at a time, never re-entrantly. */
class FakeScheduler : Scheduler {
    private var clock = 0L
    private val queue = ArrayList<Pair<Long, () -> Unit>>()
    private var running = false

    override fun now(): Long = clock

    override fun post(task: () -> Unit) {
        queue += clock to task
        drain()
    }

    override fun postDelayed(delayMs: Long, task: () -> Unit): Timer {
        val entry = (clock + delayMs) to task
        queue += entry
        return object : Timer {
            override fun cancel() {
                queue.remove(entry)
            }
        }
    }

    fun advance(ms: Long) {
        val end = clock + ms
        while (true) {
            val next = queue.filter { it.first <= end }.minByOrNull { it.first } ?: break
            clock = maxOf(clock, next.first)
            queue.remove(next)
            run(next.second)
        }
        clock = end
    }

    private fun run(task: () -> Unit) {
        if (running) {
            task()
            return
        }
        running = true
        try {
            task()
        } finally {
            running = false
        }
        drain()
    }

    private fun drain() {
        if (running) return
        running = true
        try {
            while (true) {
                val next = queue.firstOrNull { it.first <= clock } ?: break
                queue.remove(next)
                next.second()
            }
        } finally {
            running = false
        }
    }
}

class FakeSocket(val url: String, val listener: LinkSocketListener) : LinkSocket {
    val sent = mutableListOf<String>()
    var closedWith: Pair<Int, String>? = null
    var cancelled = false
    override fun send(text: String): Boolean {
        sent += text
        return true
    }
    override fun close(code: Int, reason: String) {
        closedWith = code to reason
    }
    override fun cancel() {
        cancelled = true
    }
}

class FakeSockets : LinkSocketFactory {
    val opened = mutableListOf<FakeSocket>()
    override fun open(url: String, listener: LinkSocketListener): LinkSocket = FakeSocket(url, listener).also { opened += it }
}

class FakeHost(var pairing: Pairing? = Pairing("https://box.example", "card", "tok"), var mode: LinkMode = LinkMode.ON_DEMAND) : LinkHost {
    val states = mutableListOf<LinkState>()
    val notes = mutableListOf<String>()
    var serviceWanted = false
    var forgotten = false
    var ended = 0
    override fun pairing(): Pairing? = pairing
    override fun mode(): LinkMode = mode
    override fun forgetPairing() {
        forgotten = true
        pairing = null
    }
    override fun serviceWanted(wanted: Boolean) {
        serviceWanted = wanted
    }
    override fun stateChanged(state: LinkState) {
        states += state
    }
    override fun connectionEnded() {
        ended += 1
    }
    override fun note(text: String) {
        notes += text
    }
}

val DirectExecutor = Executor { it.run() }
