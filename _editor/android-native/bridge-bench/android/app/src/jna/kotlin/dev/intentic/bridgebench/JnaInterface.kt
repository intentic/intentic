package dev.intentic.bridgebench

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer

/** `src/c.rs` through JNA's interface mapping: `Native.load` answers a proxy that looks each function up by name. */
@Suppress("FunctionName")
internal interface BridgeLibrary : Library {
    fun bb_noop()

    fun bb_echo(request: String): Pointer

    fun bb_string_free(reply: Pointer)

    fun bb_bytes(input: ByteArray, len: Int, outLen: IntArray): Pointer

    fun bb_bytes_free(data: Pointer, len: Int)
}

internal class JnaInterfaceBridge private constructor(private val lib: BridgeLibrary) : Bridge {
    override fun noop() = lib.bb_noop()

    override fun echo(request: String): String {
        val reply = lib.bb_echo(request)
        try {
            return reply.getString(0, "UTF-8")
        } finally {
            lib.bb_string_free(reply)
        }
    }

    override fun bytes(input: ByteArray): ByteArray {
        val len = IntArray(1)
        val out = lib.bb_bytes(input, input.size, len)
        try {
            return out.getByteArray(0, len[0])
        } finally {
            lib.bb_bytes_free(out, len[0])
        }
    }

    companion object {
        fun load(): Bridge = JnaInterfaceBridge(Native.load(LIBRARY, BridgeLibrary::class.java))
    }
}
