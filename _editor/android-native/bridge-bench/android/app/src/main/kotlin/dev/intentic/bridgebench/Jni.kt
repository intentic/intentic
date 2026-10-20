package dev.intentic.bridgebench

/** The functions `src/jni.rs` exports, bound by JNI name. */
object Jni {
    @JvmStatic external fun noop()

    @JvmStatic external fun echo(request: String): String

    /** [echo] reading its argument as `_editor/mobile-core`'s bridge does, with the `jni` crate's checked `get_string`. */
    @JvmStatic external fun echoChecked(request: String): String

    @JvmStatic external fun bytes(input: ByteArray): ByteArray
}

class JniBridge private constructor() : Bridge {
    override fun noop() = Jni.noop()

    override fun echo(request: String): String = Jni.echo(request)

    override fun bytes(input: ByteArray): ByteArray = Jni.bytes(input)

    companion object {
        fun load(): Bridge {
            System.loadLibrary(LIBRARY)
            return JniBridge()
        }
    }
}
