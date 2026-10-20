// `app`, and two test modules that only run against it on a device: `baselineprofile` records its Baseline Profile,
// `benchmark` times its start, scrolling and streaming (Macrobenchmark).
//
// AGP 9 compiles Kotlin itself, so no kotlin-android plugin. AGP 9.4.1 brings Kotlin 2.2.10, which cannot read
// kotlinx.serialization 1.11 (built with 2.4): the serialization plugin at 2.4.21 puts that Kotlin Gradle plugin on the
// classpath, and AGP compiles with it.
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("com.android.test") version "9.4.1" apply false
    id("androidx.baselineprofile") version "1.5.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21" apply false
}
