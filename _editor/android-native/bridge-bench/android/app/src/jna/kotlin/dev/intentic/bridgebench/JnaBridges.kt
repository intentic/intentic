package dev.intentic.bridgebench

/** The modes that reach Rust through JNA; `src/nojna` stands in for this file in the build without JNA. */
internal fun loadJna(mode: String): Bridge =
    when (mode) {
        "jna-direct" -> JnaDirectBridge.load()
        "jna-interface" -> JnaInterfaceBridge.load()
        "uniffi" -> UniffiBridge.load()
        else -> throw IllegalArgumentException("unknown mode $mode")
    }
