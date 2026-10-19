// One module, `app`. AGP 9 compiles Kotlin itself, so no kotlin-android plugin; Compose and kotlinx.serialization
// add their compiler plugins. AGP 9.4.1 brings Kotlin 2.2.10, which cannot read the current markdown renderer
// (built with 2.4.21): these plugins at 2.4.21 put that Kotlin Gradle plugin on the classpath, and AGP compiles with it.
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21" apply false
}
