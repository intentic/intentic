package dev.intentic.bridgebench

/**
 * The three operations, whichever way Kotlin reaches Rust: what the bench times. [echo] has the shape of the app core's
 * bridge call (JSON in, new JSON out); [bytes] has the shape of how UniFFI passes everything that is not a number.
 */
interface Bridge {
    fun noop()

    fun echo(request: String): String

    fun bytes(input: ByteArray): ByteArray
}

/** The library `../../src` builds, `libbridgebench.so`. */
const val LIBRARY = "bridgebench"

/** A request the size the app core's bridge carries: 200 bytes of JSON. */
const val REQUEST =
    """{"id":42,"type":"OpenConversation","content":{"conversationId":"cnv_soft_deletes","rows":{"from":0,"to":2000},""" +
        """"since":1760900000000,"render":{"width":1080,"theme":"dark","fontScale":1.0,"wrap":true}}}"""

/** [REQUEST]'s UTF-8 bytes, what [Bridge.bytes] carries. */
val PAYLOAD: ByteArray = REQUEST.encodeToByteArray()

/**
 * Loads the library the way [mode] names: `jni` (System.loadLibrary), `jna-direct` (Native.register), `jna-interface`
 * (Native.load) or `uniffi` (Native.register, with UniFFI's structs and load-time checks).
 */
fun loadBridge(mode: String): Bridge = if (mode == "jni") JniBridge.load() else loadJna(mode)
