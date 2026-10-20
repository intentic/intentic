package dev.intentic.bridgebench

/** The build without JNA (`-Pjna=false`), which `scripts/apk-size.sh` weighs the full one against: only `jni` runs. */
internal fun loadJna(mode: String): Bridge =
    throw IllegalArgumentException("mode $mode needs JNA, which this build leaves out")
