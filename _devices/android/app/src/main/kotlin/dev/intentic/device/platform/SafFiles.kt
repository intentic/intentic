package dev.intentic.device.platform

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.webkit.MimeTypeMap
import dev.intentic.device.store.Folder
import dev.intentic.device.tools.FileEntry
import dev.intentic.device.tools.FilesPort
import dev.intentic.device.tools.ToolFailed
import java.io.FileNotFoundException
import java.io.InputStream

/**
 * The folders the owner picked, through the Storage Access Framework: a tree URI with a persisted permission, walked by
 * display name. Nothing here forms a filesystem path, so there is no path to escape, and a folder whose permission Android
 * took back answers with a sentence asking the owner to pick it again.
 */
class SafFiles(context: Context) : FilesPort {
    private val resolver: ContentResolver = context.contentResolver

    private class Doc(val id: String, val uri: Uri, val name: String, val mime: String?, val size: Long, val modified: Long) {
        val isDirectory: Boolean get() = mime == Document.MIME_TYPE_DIR

        fun entry(): FileEntry = FileEntry(name, isDirectory, size, modified, if (isDirectory) null else mime)
    }

    private fun tree(folder: Folder): Uri = Uri.parse(folder.uri)

    private fun lost(folder: Folder): ToolFailed =
        ToolFailed("The app can no longer open the folder \"${folder.name}\". The person has to pick it again in the Intentic Device app.")

    private fun root(folder: Folder): Doc {
        val tree = tree(folder)
        val id = DocumentsContract.getTreeDocumentId(tree)
        return Doc(id, DocumentsContract.buildDocumentUriUsingTree(tree, id), folder.name, Document.MIME_TYPE_DIR, 0, 0)
    }

    private fun children(folder: Folder, parent: Doc): List<Doc> {
        val tree = tree(folder)
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent.id)
        val docs = ArrayList<Doc>()
        try {
            resolver.query(uri, PROJECTION, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0)
                    docs += Doc(
                        id, DocumentsContract.buildDocumentUriUsingTree(tree, id), cursor.getString(1).orEmpty(), cursor.getString(2),
                        if (cursor.isNull(3)) 0 else cursor.getLong(3), if (cursor.isNull(4)) 0 else cursor.getLong(4),
                    )
                }
            }
        } catch (ignored: SecurityException) {
            throw lost(folder)
        } catch (ignored: IllegalArgumentException) {
            throw lost(folder)
        } catch (ignored: UnsupportedOperationException) {
            throw lost(folder)
        }
        return docs
    }

    /** The document at [path], or null when a name on the way is not there. */
    private fun walk(folder: Folder, path: List<String>): Doc? {
        var current = root(folder)
        for (name in path) {
            if (!current.isDirectory) {
                return null
            }
            current = children(folder, current).firstOrNull { it.name == name } ?: return null
        }
        return current
    }

    override fun list(folder: Folder, path: List<String>): List<FileEntry> {
        val doc = walk(folder, path) ?: throw ToolFailed("\"${path.joinToString("/")}\" does not exist in the folder \"${folder.name}\".")
        if (!doc.isDirectory) {
            throw ToolFailed("\"${path.joinToString("/")}\" is a file, not a folder: use read_file.")
        }
        return children(folder, doc).filter { it.name != TRASH }.map { it.entry() }
    }

    override fun stat(folder: Folder, path: List<String>): FileEntry? = walk(folder, path)?.entry()

    override fun open(folder: Folder, path: List<String>): InputStream {
        val doc = walk(folder, path) ?: throw ToolFailed("\"${path.joinToString("/")}\" does not exist in the folder \"${folder.name}\".")
        return try {
            resolver.openInputStream(doc.uri) ?: throw ToolFailed("Android would not open \"${path.joinToString("/")}\".")
        } catch (ignored: SecurityException) {
            throw lost(folder)
        } catch (ignored: FileNotFoundException) {
            throw ToolFailed("\"${path.joinToString("/")}\" is gone.")
        }
    }

    override fun write(folder: Folder, path: List<String>, data: ByteArray) {
        try {
            var parent = root(folder)
            for (name in path.dropLast(1)) {
                parent = children(folder, parent).firstOrNull { it.name == name }?.also {
                    if (!it.isDirectory) throw ToolFailed("\"$name\" is a file, so nothing can be created inside it.")
                } ?: create(parent, Document.MIME_TYPE_DIR, name)
            }
            val name = path.last()
            val existing = children(folder, parent).firstOrNull { it.name == name }
            if (existing?.isDirectory == true) {
                throw ToolFailed("\"${path.joinToString("/")}\" is a folder, so a file cannot replace it.")
            }
            val target = existing?.uri ?: create(parent, mimeFor(name), name).uri
            // "wt" truncates: a file replaced by a shorter text must not keep its old tail.
            (resolver.openOutputStream(target, "wt") ?: throw ToolFailed("Android would not open \"$name\" for writing.")).use { it.write(data) }
        } catch (ignored: SecurityException) {
            throw lost(folder)
        } catch (ignored: FileNotFoundException) {
            throw ToolFailed("Android could not write \"${path.joinToString("/")}\".")
        }
    }

    override fun trash(folder: Folder, path: List<String>): String {
        if (path.first() == TRASH) {
            throw ToolFailed("That is already in the trash folder, which only the person empties.")
        }
        try {
            val doc = walk(folder, path) ?: throw ToolFailed("\"${path.joinToString("/")}\" does not exist in the folder \"${folder.name}\".")
            val parent = walk(folder, path.dropLast(1)) ?: throw ToolFailed("\"${path.dropLast(1).joinToString("/")}\" does not exist.")
            val top = root(folder)
            val trash = children(folder, top).firstOrNull { it.name == TRASH } ?: create(top, Document.MIME_TYPE_DIR, TRASH)
            val moved = try {
                DocumentsContract.moveDocument(resolver, doc.uri, parent.uri, trash.uri)
            } catch (ignored: UnsupportedOperationException) {
                null
            } catch (ignored: IllegalStateException) {
                null
            } catch (ignored: FileNotFoundException) {
                null
            }
            if (moved == null) {
                if (doc.isDirectory) {
                    throw ToolFailed("This folder's storage cannot move folders, so \"${path.joinToString("/")}\" was not trashed. The person has to remove it themselves.")
                }
                // The provider cannot move: copy into the trash, then remove the original. The copy is checked before the original goes.
                val copy = create(trash, doc.mime ?: "application/octet-stream", doc.name)
                resolver.openInputStream(doc.uri).use { input ->
                    resolver.openOutputStream(copy.uri, "wt").use { output ->
                        if (input == null || output == null) throw ToolFailed("Android would not open \"${doc.name}\" to move it.")
                        input.copyTo(output)
                    }
                }
                if (!DocumentsContract.deleteDocument(resolver, doc.uri)) {
                    throw ToolFailed("Copied \"${doc.name}\" into $TRASH but Android would not remove the original.")
                }
            }
            return TRASH
        } catch (ignored: SecurityException) {
            throw lost(folder)
        }
    }

    private fun create(parent: Doc, mime: String, name: String): Doc {
        val uri = DocumentsContract.createDocument(resolver, parent.uri, mime, name)
            ?: throw ToolFailed("Android would not create \"$name\" here.")
        return Doc(DocumentsContract.getDocumentId(uri), uri, name, mime, 0, 0)
    }

    private fun mimeFor(name: String): String {
        val extension = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
    }

    companion object {
        /** The trash folder inside each picked folder: where trash_file moves things, and where the owner gets them back. */
        const val TRASH = ".intentic-trash"

        private val PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED,
        )

        /** The name a picked tree goes by: its own display name, else the last part of its document id ("primary:Download" is "Download"). */
        fun displayName(context: Context, tree: Uri): String {
            val id = DocumentsContract.getTreeDocumentId(tree)
            val named = try {
                context.contentResolver.query(
                    DocumentsContract.buildDocumentUriUsingTree(tree, id), arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null,
                )?.use { if (it.moveToFirst()) it.getString(0) else null }
            } catch (ignored: RuntimeException) {
                null
            }
            return named?.takeIf { it.isNotBlank() } ?: id.substringAfterLast(':').substringAfterLast('/').ifBlank { "Folder" }
        }
    }
}
