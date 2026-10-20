package dev.intentic.bridgebench

import com.sun.jna.Native
import com.sun.jna.Pointer

/**
 * `src/c.rs` through JNA's direct mapping: `Native.register` binds each `external fun` to the C function of its name,
 * the way UniFFI's generated `UniffiLib` object does.
 */
@Suppress("FunctionName")
internal object JnaDirectLib {
    init {
        Native.register(JnaDirectLib::class.java, LIBRARY)
    }

    fun ensureInitialized() = Unit

    external fun bb_noop()

    external fun bb_echo(request: String): Pointer

    external fun bb_string_free(reply: Pointer)

    external fun bb_bytes(input: ByteArray, len: Int, outLen: IntArray): Pointer

    external fun bb_bytes_free(data: Pointer, len: Int)
}

internal class JnaDirectBridge private constructor() : Bridge {
    override fun noop() = JnaDirectLib.bb_noop()

    override fun echo(request: String): String {
        val reply = JnaDirectLib.bb_echo(request)
        try {
            return reply.getString(0, "UTF-8")
        } finally {
            JnaDirectLib.bb_string_free(reply)
        }
    }

    override fun bytes(input: ByteArray): ByteArray {
        val len = IntArray(1)
        val out = JnaDirectLib.bb_bytes(input, input.size, len)
        try {
            return out.getByteArray(0, len[0])
        } finally {
            JnaDirectLib.bb_bytes_free(out, len[0])
        }
    }

    companion object {
        fun load(): Bridge {
            JnaDirectLib.ensureInitialized()
            return JnaDirectBridge()
        }
    }
}
