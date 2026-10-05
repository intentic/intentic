package dev.intentic.device.tools

import dev.intentic.device.policy.Switch
import dev.intentic.device.store.Folder
import dev.intentic.device.store.FolderStore
import org.json.JSONObject
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale

/*
 * The four file tools. `folder` is the NAME of a folder the owner picked in the app (a Storage Access Framework tree
 * with a persisted permission), `path` is relative to it, and nothing outside the picked folders is reachable.
 */

private fun folderNamed(store: FolderStore, name: String): Folder {
    store.find(name)?.let { return it }
    val names = store.all().map { it.name }
    throw ToolFailed(
        if (names.isEmpty()) {
            "The person has not picked any folder in the Intentic Device app yet, so there is nothing to reach."
        } else {
            "There is no folder \"$name\" on this phone. The folders the person picked: ${names.joinToString(", ") { "\"$it\"" }}."
        },
    )
}

private val folderArg = "folder" to Schemas.string("The name of a folder the person picked, as `describe` lists it.")

/** `list_dir` */
class ListDirTool(private val folders: FolderStore, private val files: FilesPort) : Tool {
    override val name = "list_dir"
    override val description =
        "List a folder the person picked in the Intentic Device app, or a folder inside it. `folder` is its name from `describe`; " +
            "`path` is relative to it, and left out for the top."
    override val inputSchema = Schemas.obj(
        folderArg,
        "path" to Schemas.string("A folder inside it, relative. Leave out for the top."),
        required = listOf("folder"),
    )
    override val effect = Effect.READ
    override val needs = Switch.FILES

    override fun call(args: JSONObject): ToolResult {
        val folder = folderNamed(folders, args.getString("folder"))
        val path = args.optString("path", "")
        val entries = files.list(folder, SafePath.segments(path)).sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))
        if (entries.isEmpty()) {
            return ToolResult.text("\"${path.ifEmpty { folder.name }}\" is empty.")
        }
        val format = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ROOT)
        val shown = entries.take(MAX_ENTRIES).map {
            if (it.isDirectory) "dir   ${it.name}/" else "file  ${it.name}  ${FileKind.size(it.size)}  ${if (it.modified > 0) format.format(Date(it.modified)) else ""}".trimEnd()
        }
        val more = if (entries.size > MAX_ENTRIES) "\n... and ${entries.size - MAX_ENTRIES} more." else ""
        return ToolResult.text("${entries.size} entries in \"${path.ifEmpty { folder.name }}\".\n${shown.joinToString("\n")}$more")
    }

    private companion object {
        const val MAX_ENTRIES = 500
    }
}

/** `read_file` */
class ReadFileTool(private val folders: FolderStore, private val files: FilesPort) : Tool {
    override val name = "read_file"
    override val description =
        "Read a file in a picked folder. Text comes back as text, in parts with `offset` (the first line, counting from 1) and `limit` " +
            "(how many lines); an image up to 5 MB comes back as an image; any other binary file is refused with its size and type."
    override val inputSchema = Schemas.obj(
        folderArg,
        "path" to Schemas.string("The file, relative to the folder."),
        "offset" to Schemas.integer("First line to read, counting from 1."),
        "limit" to Schemas.integer("At most this many lines."),
        required = listOf("folder", "path"),
    )
    override val effect = Effect.READ
    override val needs = Switch.FILES

    override fun call(args: JSONObject): ToolResult {
        val folder = folderNamed(folders, args.getString("folder"))
        val path = args.getString("path")
        val segments = SafePath.nonEmpty(path)
        val entry = files.stat(folder, segments) ?: throw ToolFailed("\"$path\" does not exist in the folder \"${folder.name}\".")
        if (entry.isDirectory) {
            throw ToolFailed("\"$path\" is a folder: use list_dir to see what is in it.")
        }
        val head = files.open(folder, segments).use { it.readHead(SNIFF_BYTES) }
        return when (val kind = FileKind.sniff(head)) {
            is FileKind.Kind.Image -> {
                if (entry.size > MAX_IMAGE_BYTES) {
                    throw ToolFailed("\"$path\" is an image of ${FileKind.size(entry.size)}, more than the ${FileKind.size(MAX_IMAGE_BYTES)} this tool shows.")
                }
                val bytes = files.open(folder, segments).use { it.readBytes() }
                ToolResult(
                    listOf(
                        ToolResult.imageBlock(Base64.getEncoder().encodeToString(bytes), kind.mimeType),
                        ToolResult.textBlock("\"$path\": ${kind.mimeType}, ${FileKind.size(entry.size)}."),
                    ),
                )
            }
            FileKind.Kind.Binary ->
                throw ToolFailed("\"$path\" is a binary file (${entry.mime ?: "unknown type"}, ${FileKind.size(entry.size)}), which read_file cannot show.")
            FileKind.Kind.Text -> {
                if (entry.size > MAX_TEXT_BYTES) {
                    throw ToolFailed("\"$path\" is ${FileKind.size(entry.size)}, more than this tool reads from a phone.")
                }
                val slice = files.open(folder, segments).use { TextSlice.read(it, entry.size, args.optIntOrNull("offset"), args.optIntOrNull("limit"), path) }
                ToolResult.text(if (slice.note == null) slice.text else "[${slice.note}]\n${slice.text}")
            }
        }
    }

    private fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) getInt(key) else null

    private companion object {
        const val SNIFF_BYTES = 8192
        const val MAX_IMAGE_BYTES = 5L * 1024 * 1024
        const val MAX_TEXT_BYTES = 32L * 1024 * 1024
    }
}

/** `write_file` */
class WriteFileTool(private val folders: FolderStore, private val files: FilesPort) : Tool {
    override val name = "write_file"
    override val description =
        "Create or replace a text file in a picked folder, creating the folders on the way. It needs the folder to be picked as " +
            "changeable in the app. Replacing a file loses its old content, so read it first when that matters."
    override val inputSchema = Schemas.obj(
        folderArg,
        "path" to Schemas.string("The file, relative to the folder."),
        "content" to Schemas.string("The whole new content of the file."),
        required = listOf("folder", "path", "content"),
    )
    override val effect = Effect.DESTRUCTIVE
    override val needs = Switch.WRITE

    override fun call(args: JSONObject): ToolResult {
        val folder = folderNamed(folders, args.getString("folder"))
        requireWritable(folder)
        val path = args.getString("path")
        val segments = SafePath.nonEmpty(path)
        val bytes = args.getString("content").toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_BYTES) {
            throw ToolFailed("That is ${FileKind.size(bytes.size.toLong())}, more than one write_file takes (${FileKind.size(MAX_BYTES.toLong())}).")
        }
        files.write(folder, segments, bytes)
        return ToolResult.text("Wrote ${FileKind.size(bytes.size.toLong())} to \"$path\" in the folder \"${folder.name}\".")
    }

    private companion object {
        const val MAX_BYTES = 5 * 1024 * 1024
    }
}

/** `trash_file` */
class TrashFileTool(private val folders: FolderStore, private val files: FilesPort) : Tool {
    override val name = "trash_file"
    override val description =
        "Move a file or folder in a picked folder into that folder's .intentic-trash, where the person can get it back. Nothing is deleted for good. " +
            "It needs the folder to be picked as changeable in the app."
    override val inputSchema = Schemas.obj(
        folderArg,
        "path" to Schemas.string("The file or folder, relative to the folder."),
        required = listOf("folder", "path"),
    )
    override val effect = Effect.WRITE
    override val needs = Switch.WRITE

    override fun call(args: JSONObject): ToolResult {
        val folder = folderNamed(folders, args.getString("folder"))
        requireWritable(folder)
        val path = args.getString("path")
        val segments = SafePath.nonEmpty(path)
        if (files.stat(folder, segments) == null) {
            throw ToolFailed("\"$path\" does not exist in the folder \"${folder.name}\".")
        }
        return ToolResult.text("Moved \"$path\" to ${files.trash(folder, segments)} in the folder \"${folder.name}\". The person can restore it from there.")
    }
}

/** Up to [max] bytes from the start; InputStream.readNBytes needs Android 13. */
private fun InputStream.readHead(max: Int): ByteArray {
    val buffer = ByteArray(max)
    var filled = 0
    while (filled < max) {
        val read = read(buffer, filled, max - filled)
        if (read < 0) {
            break
        }
        filled += read
    }
    return buffer.copyOf(filled)
}

private fun requireWritable(folder: Folder) {
    if (!folder.writable) {
        throw ToolRefused("Refused: the person picked the folder \"${folder.name}\" read-only in the Intentic Device app.")
    }
}
