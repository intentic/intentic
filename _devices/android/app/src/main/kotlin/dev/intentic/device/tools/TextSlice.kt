package dev.intentic.device.tools

import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

/** What a file is, from its first bytes. A file's name and MIME type on a phone are whatever the app that made it said. */
object FileKind {
    sealed interface Kind {
        data object Text : Kind

        data object Binary : Kind

        data class Image(val mimeType: String) : Kind
    }

    /** The first bytes decide: a known image signature, else text when no NUL byte is there and it decodes as UTF-8, else binary. */
    fun sniff(head: ByteArray): Kind {
        imageType(head)?.let { return Kind.Image(it) }
        if (head.any { it == 0.toByte() }) {
            return Kind.Binary
        }
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        // Not the end of the input: a multi-byte character cut by the size of the head is not malformed.
        val result = decoder.decode(ByteBuffer.wrap(head), CharBuffer.allocate(head.size + 1), false)
        return if (result.isError) Kind.Binary else Kind.Text
    }

    private fun imageType(head: ByteArray): String? {
        fun starts(vararg bytes: Int) = head.size >= bytes.size && bytes.indices.all { head[it] == bytes[it].toByte() }
        return when {
            starts(0x89, 0x50, 0x4E, 0x47) -> "image/png"
            starts(0xFF, 0xD8, 0xFF) -> "image/jpeg"
            starts(0x47, 0x49, 0x46, 0x38) -> "image/gif"
            head.size >= 12 && starts(0x52, 0x49, 0x46, 0x46) && head[8] == 'W'.code.toByte() && head[9] == 'E'.code.toByte() &&
                head[10] == 'B'.code.toByte() && head[11] == 'P'.code.toByte() -> "image/webp"
            else -> null
        }
    }

    /** "812 bytes", "2.1 MB". */
    fun size(bytes: Long): String =
        when {
            bytes < 1024 -> "$bytes bytes"
            bytes < 1024 * 1024 -> "%.1f KB".format(java.util.Locale.ROOT, bytes / 1024.0)
            else -> "%.1f MB".format(java.util.Locale.ROOT, bytes / (1024.0 * 1024.0))
        }
}

/** Reads a text file in parts, the way the desktop agent's read_file does: from line `offset` (counting from 1), at most `limit` lines. */
object TextSlice {
    /** What one read answers with: the [text], and a [note] saying where it sits in the file whenever that is not all of it. */
    data class Slice(val text: String, val note: String?)

    /** The most characters one read answers with; the rest is reached by reading on from the line it names. */
    const val MAX_CHARS = 100_000

    /** A file this small has its lines counted, so the note can say how many there are. */
    private const val COUNTABLE_BYTES = 2L * 1024 * 1024

    fun read(input: InputStream, size: Long, offset: Int?, limit: Int?, name: String): Slice {
        val first = offset ?: 1
        val countable = size <= COUNTABLE_BYTES
        val reader = input.bufferedReader(Charsets.UTF_8)
        val shown = StringBuilder()
        var shownLines = 0
        var linesRead = 0
        var stopped = false
        var cut = false
        var more = false
        var reachedEnd = false
        while (true) {
            val text = reader.readLine()
            if (text == null) {
                reachedEnd = true
                break
            }
            linesRead += 1
            if (linesRead < first) {
                continue
            }
            if (!stopped) {
                val atLimit = limit != null && shownLines >= limit
                val fits = shown.length + (if (shownLines > 0) 1 else 0) + text.length <= MAX_CHARS
                if (!atLimit && fits) {
                    if (shownLines > 0) {
                        shown.append('\n')
                    }
                    shown.append(text)
                    shownLines += 1
                    continue
                }
                if (!atLimit && shownLines == 0) {
                    // The first line alone is more than one read holds: its start is shown, and the note says so.
                    shown.append(text, 0, MAX_CHARS)
                    shownLines = 1
                    cut = true
                }
                stopped = true
            }
            // Something exists past what is shown. A file too big to count is not read to its end for the number.
            more = true
            if (!countable) {
                break
            }
        }
        if (linesRead == 0) {
            return Slice("", "\"$name\" is empty.")
        }
        if (reachedEnd && linesRead < first) {
            throw ToolFailed("\"$name\" has $linesRead ${if (linesRead == 1) "line" else "lines"}, so there is nothing from line $first on.")
        }
        val last = first + shownLines - 1
        if (first == 1 && !more) {
            return Slice(shown.toString(), null)
        }
        val of = if (reachedEnd) " of $linesRead" else ""
        val rest = when {
            !more -> ""
            reachedEnd -> " ${linesRead - last} more after these: continue with offset ${last + 1}."
            else -> " There is more: continue with offset ${last + 1}."
        }
        val longLine = if (cut) " Line $first alone is longer than one read shows, so only its start is here." else ""
        return Slice(shown.toString(), "Lines $first-$last$of.$rest$longLine")
    }
}
