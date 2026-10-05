package dev.intentic.device.store

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/** The two ways the owner picks the link to behave. */
enum class LinkMode(val key: String) {
    /** Connect when the app is opened or the sandbox wakes it, and close after five quiet minutes. */
    ON_DEMAND("on-demand"),

    /** Keep the link up, retrying with the backoff, and start again after boot. */
    STAY("stay"),
}

/** The owner's choices that are not a list: how the link behaves, and whether the agent is paused. */
class Settings(private val kv: KeyValue) {
    private val pauseListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()

    var mode: LinkMode
        get() = LinkMode.entries.firstOrNull { it.key == kv.getString("mode") } ?: LinkMode.ON_DEMAND
        set(value) = kv.putString("mode", value.key)

    /** Kept across restarts: a reboot must not quietly end the owner's pause. */
    var paused: Boolean
        get() = kv.getBoolean("paused", false)
        set(value) {
            if (value != paused) {
                kv.putBoolean("paused", value)
                pauseListeners.forEach { it(value) }
            }
        }

    /** The Firebase token this phone can be woken with, when Firebase is configured and Google Play services gave one. */
    var fcmToken: String?
        get() = kv.getString("fcmToken")
        set(value) = kv.putString("fcmToken", value)

    fun onPauseChanged(listener: (Boolean) -> Unit) {
        pauseListeners += listener
    }
}

/** The sandbox this phone is paired with: its address, the card's id, and the durable token (sealed at rest). */
data class Pairing(val sandboxUrl: String, val id: String, val token: String)

class PairingStore(private val kv: KeyValue, private val box: SecretBox) {
    @Volatile
    private var cached: Pairing? = null

    @Volatile
    private var loaded = false

    @Synchronized
    fun get(): Pairing? {
        if (!loaded) {
            cached = read()
            loaded = true
        }
        return cached
    }

    @Synchronized
    fun save(pairing: Pairing) {
        kv.putString("pairing.url", pairing.sandboxUrl)
        kv.putString("pairing.id", pairing.id)
        kv.putString("pairing.token", box.seal(pairing.token))
        cached = pairing
        loaded = true
    }

    @Synchronized
    fun clear() {
        kv.putString("pairing.url", null)
        kv.putString("pairing.id", null)
        kv.putString("pairing.token", null)
        cached = null
        loaded = true
    }

    private fun read(): Pairing? {
        val url = kv.getString("pairing.url") ?: return null
        val id = kv.getString("pairing.id") ?: return null
        val sealed = kv.getString("pairing.token") ?: return null
        // A token that will not open (the Keystore key is gone) is no pairing: the owner pairs again.
        val token = box.open(sealed) ?: return null
        return Pairing(url, id, token)
    }
}

/** A list kept as a JSON array under one key. */
private class JsonList(private val kv: KeyValue, private val key: String) {
    fun read(): List<JSONObject> {
        val text = kv.getString(key) ?: return emptyList()
        return try {
            val array = JSONArray(text)
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }
        } catch (ignored: JSONException) {
            emptyList()
        }
    }

    fun write(items: List<JSONObject>) {
        kv.putString(key, if (items.isEmpty()) null else JSONArray(items).toString())
    }
}

/** A folder the owner picked: the name the agent addresses it with, the tree Android granted, and whether it may be changed. */
data class Folder(val name: String, val uri: String, val writable: Boolean)

class FolderStore(kv: KeyValue) {
    private val list = JsonList(kv, "folders")

    @Synchronized
    fun all(): List<Folder> = list.read().map { Folder(it.optString("name"), it.optString("uri"), it.optBoolean("writable")) }

    /** Exact name first; a case-insensitive match only when it is unambiguous. */
    fun find(name: String): Folder? {
        val folders = all()
        return folders.firstOrNull { it.name == name } ?: folders.filter { it.name.equals(name, ignoreCase = true) }.singleOrNull()
    }

    /** Adds a folder; a name already taken becomes "Name (2)". */
    @Synchronized
    fun add(name: String, uri: String, writable: Boolean): Folder {
        val folders = all()
        val taken = folders.map { it.name.lowercase() }.toSet()
        var unique = name
        var counter = 2
        while (unique.lowercase() in taken) {
            unique = "$name ($counter)"
            counter += 1
        }
        val added = Folder(unique, uri, writable)
        write(folders + added)
        return added
    }

    @Synchronized
    fun remove(name: String): Folder? {
        val folders = all()
        val gone = folders.firstOrNull { it.name == name } ?: return null
        write(folders - gone)
        return gone
    }

    @Synchronized
    fun clear(): List<Folder> {
        val gone = all()
        write(emptyList())
        return gone
    }

    private fun write(folders: List<Folder>) {
        list.write(folders.map { JSONObject().put("name", it.name).put("uri", it.uri).put("writable", it.writable) })
    }
}

/** What the agent may do in an allowed app: look, or look and touch. */
enum class AppMode(val key: String) {
    READ("read"),
    ACT("act"),
    ;

    companion object {
        fun of(key: String?): AppMode? = entries.firstOrNull { it.key == key }
    }
}

/** An app the owner allowed the agent into. [sensitive] marks one that always asks first, and "Destructive actions" must be on to act in. */
data class AllowedApp(val pkg: String, val label: String, val mode: AppMode, val sensitive: Boolean)

/** The phone's own allow-list. The agent asks (ask_access), only the owner grants. */
class AppAllowList(kv: KeyValue) {
    private val list = JsonList(kv, "apps")

    @Synchronized
    fun all(): List<AllowedApp> =
        list.read().mapNotNull {
            val mode = AppMode.of(it.optString("mode")) ?: return@mapNotNull null
            AllowedApp(it.optString("package"), it.optString("label"), mode, it.optBoolean("sensitive"))
        }

    fun find(pkg: String): AllowedApp? = all().firstOrNull { it.pkg == pkg }

    /** Adds the app or replaces its entry. */
    @Synchronized
    fun put(app: AllowedApp) {
        write(all().filter { it.pkg != app.pkg } + app)
    }

    @Synchronized
    fun remove(pkg: String) {
        write(all().filter { it.pkg != pkg })
    }

    @Synchronized
    fun clear() {
        write(emptyList())
    }

    private fun write(apps: List<AllowedApp>) {
        list.write(
            apps.map { JSONObject().put("package", it.pkg).put("label", it.label).put("mode", it.mode.key).put("sensitive", it.sensitive) },
        )
    }
}

/** An ask_access the owner has not answered yet. */
data class AccessRequest(val pkg: String, val label: String, val mode: AppMode, val reason: String, val at: Long)

/** Requests waiting for the owner. Never grants: [AppAllowList] changes only when the owner taps Allow. */
class AccessRequests(private val kv: KeyValue, private val now: () -> Long = System::currentTimeMillis) {
    private val list = JsonList(kv, "accessRequests")

    @Synchronized
    fun all(): List<AccessRequest> {
        val fresh = list.read().mapNotNull {
            val mode = AppMode.of(it.optString("mode")) ?: return@mapNotNull null
            AccessRequest(it.optString("package"), it.optString("label"), mode, it.optString("reason"), it.optLong("at"))
        }.filter { now() - it.at < EXPIRES_MS }
        return fresh
    }

    fun find(pkg: String, mode: AppMode): AccessRequest? = all().firstOrNull { it.pkg == pkg && it.mode == mode }

    /** Records a request; false when the same app and mode is already waiting (the agent asking again changes nothing) or too many wait. */
    @Synchronized
    fun add(request: AccessRequest): Boolean {
        val waiting = all()
        if (waiting.any { it.pkg == request.pkg && it.mode == request.mode } || waiting.size >= MAX_WAITING) {
            return false
        }
        write(waiting + request)
        return true
    }

    @Synchronized
    fun remove(pkg: String, mode: AppMode) {
        write(all().filterNot { it.pkg == pkg && it.mode == mode })
    }

    /** The owner said no: the same ask is not shown to them again for [COOLDOWN_MS], however often the agent repeats it. */
    @Synchronized
    fun deny(pkg: String, mode: AppMode) {
        val denied = deniedAt()
        denied.put("$pkg/${mode.key}", now())
        kv.putString("accessDenied", denied.toString())
    }

    fun deniedRecently(pkg: String, mode: AppMode): Boolean = now() - deniedAt().optLong("$pkg/${mode.key}", Long.MIN_VALUE / 2) < COOLDOWN_MS

    private fun deniedAt(): JSONObject =
        try {
            JSONObject(kv.getString("accessDenied") ?: "{}")
        } catch (ignored: JSONException) {
            JSONObject()
        }

    @Synchronized
    fun clear() {
        write(emptyList())
        kv.putString("accessDenied", null)
    }

    private fun write(requests: List<AccessRequest>) {
        list.write(
            requests.map {
                JSONObject().put("package", it.pkg).put("label", it.label).put("mode", it.mode.key).put("reason", it.reason).put("at", it.at)
            },
        )
    }

    companion object {
        const val MAX_WAITING = 8
        const val EXPIRES_MS = 24 * 60 * 60_000L
        const val COOLDOWN_MS = 60 * 60_000L
    }
}
