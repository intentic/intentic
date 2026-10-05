package dev.intentic.device

import dev.intentic.device.tools.FileKind
import dev.intentic.device.tools.SafePath
import dev.intentic.device.tools.TextSlice
import dev.intentic.device.tools.ToolFailed
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

class SafePathTest {
    @Test
    fun `a relative path is split into the names to walk`() {
        assertEquals(listOf("a", "b", "c.txt"), SafePath.segments("a/b/c.txt"))
        assertEquals(listOf("a", "b"), SafePath.segments("./a//b/"))
        assertEquals(emptyList<String>(), SafePath.segments(""))
        assertEquals(emptyList<String>(), SafePath.segments("."))
    }

    @Test
    fun `dot dot is refused wherever it sits and whichever slash it uses`() {
        for (path in listOf("..", "../x", "a/../b", "a/b/..", "a\\..\\b", "..\\x", "a/./../b")) {
            try {
                SafePath.segments(path)
                fail("$path was not refused")
            } catch (refused: ToolFailed) {
                assertTrue(refused.message!!.contains(".."))
            }
        }
    }

    @Test
    fun `an absolute path or a NUL is refused`() {
        for (path in listOf("/etc/passwd", "/", "\\windows", "a\u0000b")) {
            try {
                SafePath.segments(path)
                fail("$path was not refused")
            } catch (ignored: ToolFailed) {
            }
        }
    }

    @Test
    fun `a name that merely contains dots is fine`() {
        assertEquals(listOf("..a", "b..", "...", ".hidden"), SafePath.segments("..a/b../.../.hidden"))
    }

    @Test
    fun `a call that needs a file does not take the folder itself`() {
        try {
            SafePath.nonEmpty("./")
            fail()
        } catch (ignored: ToolFailed) {
        }
        assertEquals(listOf("x"), SafePath.nonEmpty("x"))
    }
}

class TextSliceTest {
    private fun read(text: String, offset: Int? = null, limit: Int? = null, size: Long = text.length.toLong()) =
        TextSlice.read(text.byteInputStream(), size, offset, limit, "f.txt")

    @Test
    fun `a whole small file comes back as is, with no note`() {
        val slice = read("one\ntwo\nthree\n")
        assertEquals("one\ntwo\nthree", slice.text)
        assertNull(slice.note)
    }

    @Test
    fun `offset counts from line 1 and limit counts lines, and the note says where to go on`() {
        val text = (1..10).joinToString("\n") { "line $it" }
        val slice = read(text, offset = 3, limit = 2)
        assertEquals("line 3\nline 4", slice.text)
        assertEquals("Lines 3-4 of 10. 6 more after these: continue with offset 5.", slice.note)
        val tail = read(text, offset = 9)
        assertEquals("line 9\nline 10", tail.text)
        assertEquals("Lines 9-10 of 10.", tail.note)
    }

    @Test
    fun `reading past the end says how many lines there are`() {
        try {
            read("a\nb", offset = 5)
            fail()
        } catch (failed: ToolFailed) {
            assertTrue(failed.message!!.contains("2 lines"))
        }
    }

    @Test
    fun `an empty file says so and a long one is cut where the answer limit falls`() {
        assertEquals("", read("").text)
        assertTrue(read("").note!!.contains("empty"))
        val long = (1..5_000).joinToString("\n") { "x".repeat(99) }
        val slice = read(long)
        assertTrue(slice.text.length <= TextSlice.MAX_CHARS)
        assertTrue(slice.note!!.contains("continue with offset"))
        val shownLines = slice.text.count { it == '\n' } + 1
        assertTrue(slice.note!!.startsWith("Lines 1-$shownLines of 5000."))
    }

    @Test
    fun `one line longer than a read keeps its start and says so`() {
        val slice = read("y".repeat(TextSlice.MAX_CHARS + 50) + "\nnext")
        assertEquals(TextSlice.MAX_CHARS, slice.text.length)
        assertTrue(slice.note!!.contains("alone is longer"))
    }

    @Test
    fun `crlf and cr line ends read as lines`() {
        assertEquals("a\nb\nc", read("a\r\nb\rc").text)
    }
}

class FileKindTest {
    @Test
    fun `text, images and binaries are told apart by their first bytes`() {
        assertEquals(FileKind.Kind.Text, FileKind.sniff("hello wörld\n".toByteArray()))
        assertEquals(FileKind.Kind.Text, FileKind.sniff(ByteArray(0)))
        assertEquals(FileKind.Kind.Image("image/png"), FileKind.sniff(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
        assertEquals(FileKind.Kind.Image("image/jpeg"), FileKind.sniff(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())))
        assertEquals(FileKind.Kind.Image("image/gif"), FileKind.sniff("GIF89a".toByteArray()))
        assertEquals(FileKind.Kind.Image("image/webp"), FileKind.sniff("RIFF\u0001\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)))
        assertEquals(FileKind.Kind.Binary, FileKind.sniff(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x00, 0x00)))
        assertEquals(FileKind.Kind.Binary, FileKind.sniff(byteArrayOf(0xC3.toByte(), 0x28)))
    }

    @Test
    fun `a multi-byte character cut by the size of the head is still text`() {
        val bytes = "ab€".toByteArray(Charsets.UTF_8)
        assertEquals(FileKind.Kind.Text, FileKind.sniff(bytes.copyOf(bytes.size - 1)))
    }

    @Test
    fun `sizes read in plain units`() {
        assertEquals("812 bytes", FileKind.size(812))
        assertEquals("1.5 KB", FileKind.size(1536))
        assertEquals("2.0 MB", FileKind.size(2 * 1024 * 1024))
    }
}

/** The four file tools, through the whole protocol, over an in-memory tree. */
class FileToolsTest {
    private fun phone(writable: Boolean = true): FakePhone {
        val phone = FakePhone()
        phone.grant("files", "write")
        phone.folders.add("Notes", "content://tree/notes", writable)
        phone.files.content["a.txt"] = "alpha\nbeta\ngamma".toByteArray()
        phone.files.content["sub/b.txt"] = "bee".toByteArray()
        phone.files.content["bin.dat"] = byteArrayOf(0, 1, 2, 3)
        phone.files.content["pic.png"] = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2)
        return phone
    }

    private fun text(result: JSONObject) = result.getJSONArray("content").getJSONObject(0).getString("text")
    private fun args(vararg pairs: Pair<String, Any>) = JSONObject().also { json -> pairs.forEach { json.put(it.first, it.second) } }

    @Test
    fun `list_dir lists the top and a subfolder`() {
        val phone = phone()
        val top = text(phone.toolCall("list_dir", args("folder" to "Notes")))
        assertTrue(top, top.contains("dir   sub/"))
        assertTrue(top, top.contains("file  a.txt"))
        assertTrue(text(phone.toolCall("list_dir", args("folder" to "Notes", "path" to "sub"))).contains("b.txt"))
        assertTrue(text(phone.toolCall("list_dir", args("folder" to "notes"))).contains("a.txt"))
    }

    @Test
    fun `read_file reads text in parts, returns an image block, and refuses other binaries with size and type`() {
        val phone = phone()
        assertEquals("alpha\nbeta\ngamma", text(phone.toolCall("read_file", args("folder" to "Notes", "path" to "a.txt"))))
        val part = text(phone.toolCall("read_file", args("folder" to "Notes", "path" to "a.txt", "offset" to 2, "limit" to 1)))
        assertTrue(part, part.endsWith("beta") && part.startsWith("[Lines 2-2 of 3."))
        val image = phone.toolCall("read_file", args("folder" to "Notes", "path" to "pic.png")).getJSONArray("content")
        assertEquals("image", image.getJSONObject(0).getString("type"))
        assertEquals("image/png", image.getJSONObject(0).getString("mimeType"))
        assertEquals(Base64.getEncoder().encodeToString(phone.files.content.getValue("pic.png")), image.getJSONObject(0).getString("data"))
        val binary = phone.toolCall("read_file", args("folder" to "Notes", "path" to "bin.dat"))
        assertTrue(binary.getBoolean("isError"))
        assertTrue(text(binary), text(binary).contains("binary") && text(binary).contains("4 bytes") && text(binary).contains("text/plain"))
    }

    @Test
    fun `path traversal is refused by every file tool, before anything is touched`() {
        val phone = phone()
        for (tool in listOf("list_dir", "read_file", "write_file", "trash_file")) {
            for (path in listOf("../outside.txt", "sub/../../x", "/abs/path")) {
                val arguments = args("folder" to "Notes", "path" to path)
                if (tool == "write_file") arguments.put("content", "pwned")
                val result = phone.toolCall(tool, arguments)
                assertTrue("$tool $path", result.getBoolean("isError"))
            }
        }
        assertFalse(phone.files.content.containsKey("outside.txt"))
        assertTrue(phone.files.trashed.isEmpty())
    }

    @Test
    fun `write_file needs a writable folder and creates or replaces the file`() {
        val phone = phone()
        assertFalse(phone.toolCall("write_file", args("folder" to "Notes", "path" to "new/c.txt", "content" to "hello")).getBoolean("isError"))
        assertEquals("hello", String(phone.files.content.getValue("new/c.txt")))
        phone.toolCall("write_file", args("folder" to "Notes", "path" to "a.txt", "content" to "replaced"))
        assertEquals("replaced", String(phone.files.content.getValue("a.txt")))

        val readOnly = phone(writable = false)
        val refused = readOnly.toolCall("write_file", args("folder" to "Notes", "path" to "x.txt", "content" to "no"))
        assertTrue(refused.getBoolean("isError"))
        assertTrue(text(refused).contains("read-only"))
        assertFalse(readOnly.files.content.containsKey("x.txt"))
        assertTrue(readOnly.toolCall("trash_file", args("folder" to "Notes", "path" to "a.txt")).getBoolean("isError"))
        assertTrue(readOnly.files.trashed.isEmpty())
    }

    @Test
    fun `trash_file moves into the trash and says where`() {
        val phone = phone()
        val moved = phone.toolCall("trash_file", args("folder" to "Notes", "path" to "a.txt"))
        assertFalse(moved.getBoolean("isError"))
        assertTrue(text(moved).contains(".intentic-trash"))
        assertEquals(listOf("a.txt"), phone.files.trashed)
        assertTrue(phone.toolCall("trash_file", args("folder" to "Notes", "path" to "missing.txt")).getBoolean("isError"))
    }

    @Test
    fun `an unknown folder names the ones there are, and no folder at all says to pick one`() {
        val phone = phone()
        assertTrue(text(phone.toolCall("list_dir", args("folder" to "Other"))).contains("\"Notes\""))
        val empty = FakePhone()
        empty.grant("files")
        assertTrue(text(empty.toolCall("list_dir", args("folder" to "Other"))).contains("not picked any folder"))
    }

    @Test
    fun `reads are refused with files off even when write is on`() {
        val phone = FakePhone()
        phone.grant("write")
        phone.folders.add("Notes", "content://tree/notes", true)
        phone.files.content["a.txt"] = "x".toByteArray()
        assertTrue(text(phone.toolCall("read_file", args("folder" to "Notes", "path" to "a.txt"))).contains("Read the folders you pick"))
        assertFalse(phone.toolCall("write_file", args("folder" to "Notes", "path" to "b.txt", "content" to "y")).getBoolean("isError"))
    }
}
