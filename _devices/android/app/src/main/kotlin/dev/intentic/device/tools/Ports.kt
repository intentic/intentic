package dev.intentic.device.tools

import dev.intentic.device.store.AppMode
import dev.intentic.device.store.Folder
import java.io.InputStream

/*
 * What the tools need of the phone, as small interfaces. The tools hold the rules (which switch, which sentence, which
 * limits); the Android classes that touch the screen, the package manager, the clipboard and the document provider sit
 * behind these in dev.intentic.device.platform, so every rule runs in a plain JVM test.
 */

/** One screenshot's pixels: a JPEG at the size the agent is shown, and the phone's own pixel size. */
class Shot(val jpeg: ByteArray, val width: Int, val height: Int, val phoneWidth: Int, val phoneHeight: Int)

interface ScreenPort {
    /** A frame of the screen, or null when the person has not approved screen capture for this session. */
    fun capture(): Shot?

    /** Asks the person, on the phone, to approve screen capture. The system dialog opens when they tap the notification. */
    fun askToShare()
}

data class InstalledApp(val pkg: String, val label: String)

enum class AccessAsk { ASKED, ALREADY_WAITING, DENIED_RECENTLY, TOO_MANY }

interface AppsPort {
    /** Every app with a launcher entry. */
    fun launchable(): List<InstalledApp>

    fun find(pkg: String): InstalledApp?

    /** Posts "Your agent wants to open <app>"; the app opens when the person taps it. */
    fun askToOpen(app: InstalledApp)

    /** Posts "Your agent wants to open <link>"; the link opens when the person taps it. */
    fun askToOpenLink(url: String)

    /** Records the request and posts a notification with Allow and Deny. Never grants. */
    fun askAccess(app: InstalledApp, mode: AppMode, reason: String): AccessAsk
}

interface ClipboardPort {
    fun put(text: String)
}

/** One thing inside a picked folder. [mime] is what the app that made it said, null for a folder. */
data class FileEntry(val name: String, val isDirectory: Boolean, val size: Long, val modified: Long, val mime: String?)

/**
 * Reads and changes files inside the folders the owner picked, reached by walking display names under the picked tree.
 * Every method throws [ToolFailed] with a sentence for a missing path, a lost permission or a refused write.
 */
interface FilesPort {
    fun list(folder: Folder, path: List<String>): List<FileEntry>

    /** Null when nothing is there. An empty [path] is the folder itself. */
    fun stat(folder: Folder, path: List<String>): FileEntry?

    fun open(folder: Folder, path: List<String>): InputStream

    /** Creates or replaces the file, creating the folders on the way. */
    fun write(folder: Folder, path: List<String>, data: ByteArray)

    /** Moves into the folder's own trash folder rather than deleting; answers where it went. */
    fun trash(folder: Folder, path: List<String>): String
}
