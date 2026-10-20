package dev.intentic.bridgebench

import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.Structure
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

// `src/rustbuffer.rs` called the way UniFFI 0.32's generated Kotlin calls a Rust function, written out by hand from
// its templates (NamespaceLibraryTemplate.kt, RustBufferTemplate.kt, Helpers.kt, StringHelper.kt, ByteArrayHelper.kt,
// FfiConverterTemplate.kt) for this bench's three functions, so the bench needs no bindgen step. JNA direct mapping;
// a struct for every buffer and every call's status; buffers allocated and freed through Rust.

@Structure.FieldOrder("capacity", "len", "data")
internal open class RustBuffer : Structure() {
    @JvmField var capacity: Long = 0

    @JvmField var len: Long = 0

    @JvmField var data: Pointer? = null

    class ByValue : RustBuffer(), Structure.ByValue

    fun asByteBuffer(): ByteBuffer? = data?.getByteBuffer(0, len)?.also { it.order(ByteOrder.BIG_ENDIAN) }

    companion object {
        fun alloc(size: Long): ByValue =
            uniffiRustCall { status -> UniffiLib.bb_rb_alloc(size, status) }.also {
                if (it.data == null) throw RuntimeException("RustBuffer.alloc() returned null data pointer (size=$size)")
            }

        fun free(buf: ByValue) = uniffiRustCall { status -> UniffiLib.bb_rb_free(buf, status) }
    }
}

@Structure.FieldOrder("code", "error_buf")
internal open class UniffiRustCallStatus : Structure() {
    @JvmField var code: Byte = 0

    @Suppress("PropertyName")
    @JvmField var error_buf: RustBuffer.ByValue = RustBuffer.ByValue()
}

private inline fun <U> uniffiRustCall(callback: (UniffiRustCallStatus) -> U): U {
    val status = UniffiRustCallStatus()
    val value = callback(status)
    if (status.code != 0.toByte()) throw IllegalStateException("Rust call failed with code ${status.code}")
    return value
}

/** The functions a load checks before any other is called: the scaffolding's contract version and each checksum. */
@Suppress("FunctionName")
internal object IntegrityCheckingUniffiLib {
    init {
        Native.register(IntegrityCheckingUniffiLib::class.java, LIBRARY)
        if (bb_rb_contract_version() != 30) throw RuntimeException("UniFFI contract version mismatch")
        if ((bb_rb_checksum_noop().toInt() and 0xFFFF) != 101 ||
            (bb_rb_checksum_echo().toInt() and 0xFFFF) != 102 ||
            (bb_rb_checksum_bytes().toInt() and 0xFFFF) != 103
        ) {
            throw RuntimeException("UniFFI API checksum mismatch")
        }
    }

    fun ensureInitialized() = Unit

    external fun bb_rb_contract_version(): Int

    external fun bb_rb_checksum_noop(): Short

    external fun bb_rb_checksum_echo(): Short

    external fun bb_rb_checksum_bytes(): Short
}

@Suppress("FunctionName")
internal object UniffiLib {
    init {
        Native.register(UniffiLib::class.java, LIBRARY)
    }

    fun ensureInitialized() = Unit

    external fun bb_rb_alloc(size: Long, status: UniffiRustCallStatus): RustBuffer.ByValue

    external fun bb_rb_free(buf: RustBuffer.ByValue, status: UniffiRustCallStatus)

    external fun bb_rb_noop(status: UniffiRustCallStatus)

    external fun bb_rb_echo(request: RustBuffer.ByValue, status: UniffiRustCallStatus): RustBuffer.ByValue

    external fun bb_rb_bytes(input: RustBuffer.ByValue, status: UniffiRustCallStatus): RustBuffer.ByValue
}

internal object FfiConverterString {
    fun lift(value: RustBuffer.ByValue): String {
        try {
            val byteArr = ByteArray(value.len.toInt())
            value.asByteBuffer()!!.get(byteArr)
            return byteArr.toString(Charsets.UTF_8)
        } finally {
            RustBuffer.free(value)
        }
    }

    private fun toUtf8(value: String): ByteBuffer =
        Charsets.UTF_8.newEncoder().run {
            onMalformedInput(CodingErrorAction.REPORT)
            encode(CharBuffer.wrap(value))
        }

    fun lower(value: String): RustBuffer.ByValue {
        val byteBuf = toUtf8(value)
        val rbuf = RustBuffer.alloc(byteBuf.limit().toLong())
        rbuf.asByteBuffer()!!.put(byteBuf)
        return rbuf
    }
}

internal object FfiConverterByteArray {
    fun lower(value: ByteArray): RustBuffer.ByValue {
        val rbuf = RustBuffer.alloc(4L + value.size)
        try {
            val bbuf = rbuf.data!!.getByteBuffer(0, rbuf.capacity).also { it.order(ByteOrder.BIG_ENDIAN) }
            bbuf.putInt(value.size)
            bbuf.put(value)
            rbuf.writeField("len", bbuf.position().toLong())
            return rbuf
        } catch (e: Throwable) {
            RustBuffer.free(rbuf)
            throw e
        }
    }

    fun lift(rbuf: RustBuffer.ByValue): ByteArray {
        val byteBuf = rbuf.asByteBuffer()!!
        try {
            val byteArr = ByteArray(byteBuf.getInt())
            byteBuf.get(byteArr)
            if (byteBuf.hasRemaining()) throw RuntimeException("junk remaining in buffer after lifting")
            return byteArr
        } finally {
            RustBuffer.free(rbuf)
        }
    }
}

internal class UniffiBridge private constructor() : Bridge {
    override fun noop() = uniffiRustCall { status -> UniffiLib.bb_rb_noop(status) }

    override fun echo(request: String): String =
        FfiConverterString.lift(uniffiRustCall { status -> UniffiLib.bb_rb_echo(FfiConverterString.lower(request), status) })

    override fun bytes(input: ByteArray): ByteArray =
        FfiConverterByteArray.lift(uniffiRustCall { status -> UniffiLib.bb_rb_bytes(FfiConverterByteArray.lower(input), status) })

    companion object {
        /** `uniffiEnsureInitialized()`, which generated code runs before its first call. */
        fun load(): Bridge {
            IntegrityCheckingUniffiLib.ensureInitialized()
            UniffiLib.ensureInitialized()
            return UniffiBridge()
        }
    }
}
