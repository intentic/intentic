package dev.intentic.device

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import dev.intentic.device.link.AndroidLinkHost
import dev.intentic.device.link.ConnectionService
import dev.intentic.device.link.ExecutorScheduler
import dev.intentic.device.link.LinkController
import dev.intentic.device.link.OkHttpSockets
import dev.intentic.device.platform.AndroidApps
import dev.intentic.device.platform.AndroidClipboard
import dev.intentic.device.platform.Awake
import dev.intentic.device.platform.DeviceFacts
import dev.intentic.device.platform.KeystoreKey
import dev.intentic.device.platform.Notifier
import dev.intentic.device.platform.SafFiles
import dev.intentic.device.platform.ScreenSession
import dev.intentic.device.policy.Gate
import dev.intentic.device.policy.ScopeStore
import dev.intentic.device.protocol.JsonRpcPeer
import dev.intentic.device.protocol.McpServer
import dev.intentic.device.protocol.PhonePeer
import dev.intentic.device.store.AccessRequests
import dev.intentic.device.store.ActivityLog
import dev.intentic.device.store.AesGcmBox
import dev.intentic.device.store.AppAllowList
import dev.intentic.device.store.FolderStore
import dev.intentic.device.store.Pairing
import dev.intentic.device.store.PairingStore
import dev.intentic.device.store.PrefsKeyValue
import dev.intentic.device.store.Settings
import dev.intentic.device.tools.FrameLog
import dev.intentic.device.tools.LogNotices
import dev.intentic.device.tools.NoticeLog
import dev.intentic.device.tools.Registry
import dev.intentic.device.tools.ToolDeps
import java.io.File
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** Told when anything the screens or the notification show may have changed. Listeners run on the main thread. */
class Changes {
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun add(listener: () -> Unit) {
        listeners += listener
    }

    fun remove(listener: () -> Unit) {
        listeners -= listener
    }

    fun fire() {
        main.post { listeners.forEach { it() } }
    }
}

/**
 * The app's parts, wired once in [DeviceApp.onCreate]. Services, receivers and the tile all live in the same process and
 * start after it, so each reaches what it needs here instead of building its own.
 */
object Graph {
    val changes = Changes()

    private lateinit var app: Application
    lateinit var settings: Settings
        private set
    lateinit var pairings: PairingStore
        private set
    lateinit var scopes: ScopeStore
        private set
    lateinit var folders: FolderStore
        private set
    lateinit var allowList: AppAllowList
        private set
    lateinit var requests: AccessRequests
        private set
    lateinit var log: ActivityLog
        private set
    lateinit var notifier: Notifier
        private set
    lateinit var apps: AndroidApps
        private set
    lateinit var screen: ScreenSession
        private set
    lateinit var awake: Awake
        private set
    lateinit var notices: NoticeLog
        private set
    val frames = FrameLog()
    lateinit var link: LinkController
        private set

    fun init(application: Application) {
        app = application
        val kv = PrefsKeyValue(application.getSharedPreferences("intentic_device", Context.MODE_PRIVATE))
        settings = Settings(kv)
        pairings = PairingStore(kv, AesGcmBox { KeystoreKey.get() })
        scopes = ScopeStore(kv)
        folders = FolderStore(kv)
        allowList = AppAllowList(kv)
        requests = AccessRequests(kv)
        log = ActivityLog(File(application.filesDir, "activity.jsonl"))
        notifier = Notifier(application)
        awake = Awake(application)
        apps = AndroidApps(application, requests, notifier)
        screen = ScreenSession(application)
        notices = NoticeLog(application.packageName)

        val facts = DeviceFacts(application, settings, folders, allowList, notices)
        val deps = ToolDeps(
            facts::json, scopes::current, Distribution.screen(screen), frames, apps, allowList, folders,
            SafFiles(application), AndroidClipboard(application), LogNotices(notices),
        )
        val gate = Gate(scopes::current, { settings.paused }, { notifier.noticeVisible() })
        val mcp = McpServer(Registry.tools(deps, Distribution.tools(deps)), gate, log, BuildConfig.VERSION_NAME) { link.activity() }
        val rpc = JsonRpcPeer(PhonePeer(facts::json, scopes, mcp))
        link = LinkController(
            host = AndroidLinkHost(application),
            sockets = OkHttpSockets(OkHttpSockets.client()),
            scheduler = ExecutorScheduler(),
            version = BuildConfig.VERSION_NAME,
            answer = { frame ->
                awake.hold(AWAKE_PER_CALL_MS)
                rpc.handle(frame)
            },
            worker = Executors.newCachedThreadPool { runnable -> Thread(runnable, "intentic-call").apply { isDaemon = true } },
        )
        settings.onPauseChanged { paused ->
            log.event(if (paused) "The agent was paused" else "The agent was resumed")
            if (paused) {
                screen.stop()
            }
            changes.fire()
        }
    }

    /** The application context, for what is built outside an activity. */
    fun appContext(): Context = app

    /** Starts the connection from somewhere Android allows it: the app open, a push, boot. */
    fun connect(context: Context) {
        if (pairings.get() != null && !ConnectionService.start(context)) {
            link.wake()
        }
    }

    /** Stores a pairing the sandbox just enrolled. A different sandbox starts with nothing granted. */
    fun pair(pairing: Pairing) {
        val old = pairings.get()
        if (old != null && old.sandboxUrl != pairing.sandboxUrl) {
            clearGrants()
        }
        pairings.save(pairing)
        // The new sandbox sends its own switches on connect; until it does every one counts as off.
        scopes.clear()
        log.event("Paired with ${hostOf(pairing.sandboxUrl)}")
        link.pairingChanged()
        changes.fire()
    }

    /** The owner unpaired, or the sandbox revoked this phone: the link closes and nothing granted under the pairing survives. */
    fun unpair(why: String?) {
        link.stop()
        pairings.clear()
        scopes.clear()
        clearGrants()
        screen.stop()
        notifier.cancelAsks()
        why?.let { log.event(it) }
        link.pairingChanged()
        changes.fire()
    }

    /** The folders and apps the owner allowed, and the requests waiting. Persisted folder permissions go back to Android. */
    private fun clearGrants() {
        for (folder in folders.clear()) {
            releaseFolder(folder.uri)
        }
        allowList.clear()
        requests.clear()
    }

    fun releaseFolder(uri: String) {
        try {
            app.contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        } catch (error: RuntimeException) {
            // Already released, or never held: nothing to give back.
        }
    }

    /** The part of a sandbox address a person recognizes. */
    fun hostOf(url: String): String = runCatching { URI(url).host }.getOrNull() ?: url

    private const val AWAKE_PER_CALL_MS = 60_000L
}
