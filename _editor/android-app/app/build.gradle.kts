import java.net.URI
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputDirectory

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("androidx.baselineprofile")
}

fun property(name: String, fallback: String): String = providers.gradleProperty("intentic.$name").orElse(fallback).get()

// The Google web client id the platform and every daemon accept ID tokens for, read from where the repository keeps it
// (_tools/constants/src/index.ts) so it is written once. A fork that signs in through its own Google project overrides it.
val googleClientId: String = property(
    "googleClientId",
    rootProject.projectDir.resolve("../../_tools/constants/src/index.ts").readText()
        .let { Regex("""export const GOOGLE_CLIENT_ID = "([^"]+)";""").find(it)?.groupValues?.get(1) }
        ?: error("no GOOGLE_CLIENT_ID in _tools/constants/src/index.ts"),
)

android {
    namespace = "dev.intentic.app"
    compileSdk = 37
    // One NDK for both jobs it has: cargo-ndk links the Rust core with it, and AGP strips that core with it.
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "dev.intentic.app"
        minSdk = 26
        targetSdk = 36
        // A store build stamps both (mobile-release.yml). The code is that workflow's run number, which the Trusted Web
        // Activity this app replaces already counted up with, so an upload never goes below one Play has seen.
        versionCode = property("versionCode", "1").toInt()
        versionName = property("versionName", "0.1.0")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "API_URL", "\"${property("apiUrl", "https://api.intentic.dev")}\"")
        buildConfigField("String", "WEB_URL", "\"${property("webUrl", "https://app.intentic.dev")}\"")
        manifestPlaceholders["webHost"] = URI(property("webUrl", "https://app.intentic.dev")).host
        buildConfigField("String", "GOOGLE_CLIENT_ID", "\"$googleClientId\"")
        // Firebase Messaging, for notifications (src/main/kotlin/.../push): the app registered in Firebase project
        // intentic-device. These are an app's public identifiers, not secrets; the API key comes in as a Gradle
        // property (`intentic.fcm.apiKey`) so it is not committed. Without it Firebase is not started at all.
        buildConfigField("String", "FCM_API_KEY", "\"${property("fcm.apiKey", "").trim()}\"")
        buildConfigField("String", "FCM_APP_ID", "\"${property("fcm.appId", "1:912688827811:android:37a02648a658388d2ede16")}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${property("fcm.projectId", "intentic-device")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${property("fcm.senderId", "912688827811")}\"")

        ndk {
            // arm64 for phones, x86_64 for the emulator. 32-bit phones are left out: Play serves them nothing.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // The five languages the web ships. Play services' libraries carry dozens more, which the app would only half speak.
    androidResources {
        localeFilters += listOf("en", "de", "es", "fr", "pl")
    }

    packaging {
        // Kotlin's reflection tables and the coroutine debugger's: nothing here reflects on Kotlin or attaches one.
        resources.excludes += listOf("kotlin/**", "DebugProbesKt.bin")
    }

    buildTypes {
        release {
            // R8 in full mode (AGP's default since 8.0) and resource shrinking.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // The debug key signs a local release build so it installs; CI replaces it with the upload key through
            // AGP's injected signing properties (-Pandroid.injected.signing.*), which win over this, so no key path is
            // ever committed.
            signingConfig = signingConfigs.getByName("debug")
            // The core's symbol table rides in the bundle, so Play shows a native crash with its function names.
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
        }
    }

    // The screens filled from fixtures (src/preview: the board, the conversation over the spike's fixture, the app's own
    // light or dark) ride in every build but `release` (androidComponents below): debug, and `bench`, a release build in
    // all but its id and key, which is what a phone's frame times say anything about. A debuggable build runs slower code
    // than the one people get. The Baseline Profile plugin's own builds of release and bench (nonMinified*, benchmark*)
    // carry them too, since the profile is recorded on those screens: no account is needed to reach them.
    buildTypes {
        create("bench") {
            initWith(getByName("release"))
            applicationIdSuffix = ".bench"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // The strings come from the web's catalogs (scripts/strings.mjs), where a language not yet translated falls
        // back to English on purpose; Android does the same, so a missing translation is not an error here.
        disable += "MissingTranslation"
    }

    testOptions {
        unitTests {
            // The tests reach android.util.Log through the event hub; a stub returning nothing keeps them on the JVM.
            isReturnDefaultValues = true
        }
    }
}

// The Rust core (../mobile-core), built for both ABIs by cargo-ndk into a directory every variant reads its native
// libraries from. Always the release profile: a debug core is too slow to judge the app by.
abstract class CargoNdk : Exec() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Internal
    abstract val ndkDir: DirectoryProperty

    override fun exec() {
        environment("ANDROID_NDK_HOME", ndkDir.get().asFile.path)
        super.exec()
    }
}

val core: File = rootProject.projectDir.resolve("../mobile-core").canonicalFile

val cargoNdk = tasks.register<CargoNdk>("cargoNdk") {
    outputDir.set(layout.buildDirectory.dir("rust/jniLibs"))
    ndkDir.set(androidComponents.sdkComponents.ndkDirectory)
    inputs.dir(core.resolve("src"))
    inputs.files(core.resolve("Cargo.toml"), core.resolve("Cargo.lock"))
    workingDir = core
    executable = "cargo"
    argumentProviders.add(CommandLineArgumentProvider {
        listOf("ndk", "-t", "arm64-v8a", "-t", "x86_64", "-P", "26", "-o", outputDir.get().asFile.path, "build", "--release", "--lib")
    })
}

// The spike's fixture conversation, carried by the preview builds only: PreviewConversation has the core open it.
abstract class FixtureAssets : Sync() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val fixtureAssets = tasks.register<FixtureAssets>("fixtureAssets") {
    outputDir.set(layout.buildDirectory.dir("generated/fixture"))
    from(rootProject.projectDir.resolve("../android-native/fixture/soft-deletes.json"))
    into(outputDir)
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(cargoNdk, CargoNdk::outputDir)
        if (variant.buildType != "release") {
            variant.sources.assets?.addGeneratedSourceDirectory(fixtureAssets, FixtureAssets::outputDir)
            variant.sources.kotlin?.addStaticSourceDirectory("src/preview/kotlin")
            variant.sources.res?.addStaticSourceDirectory("src/preview/res")
            variant.sources.manifests.addStaticManifestFile("src/preview/AndroidManifest.xml")
        }
    }
}

// The Baseline Profile: the classes and methods a start and a conversation's scrolling and streaming run, compiled ahead
// of time on install instead of interpreted until the JIT gets to them. Recorded by :baselineprofile on an emulator
// (`bash scripts/gradle.sh :app:generateBaselineProfile`), committed under src/main/baselineProfiles, and read by every
// build from there; nothing records one during a build.
baselineProfile {
    automaticGenerationDuringBuild = false
    saveInSrc = true
    mergeIntoMain = true
    // src/main/baselineProfiles, which AGP reads by itself (the plugin's default, generated/, is ignored by git here).
    baselineProfileOutputDir = "baselineProfiles"
    // The profile keeps the preview screens' own few rules (dev/intentic/app/Preview*): the plugin's `filter` left them
    // in (1.5.0 under AGP 9), and they match nothing in a release build's dex, so its compiled profile drops them.
}

dependencies {
    implementation("androidx.core:core:1.19.1")
    implementation("androidx.activity:activity:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")
    // Custom Tabs: the browser sign-in, and the web's agent page until the native conversation lands.
    implementation("androidx.browser:browser:1.10.0")
    // The shared WebView's message channel (addWebMessageListener), which only the web editor's own origin can reach.
    implementation("androidx.webkit:webkit:1.17.1")
    // Sign in with Google through Credential Manager; the Play services half is what answers on phones before Android 14.
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.2.1")
    // Play services brings Fragment 1.0, whose activity-result plumbing the WebView screen's file picker would trip over
    // (lint's InvalidFragmentVersionForActivityResult); the app uses no fragments itself.
    implementation("androidx.fragment:fragment:1.9.1")
    // Installs the Baseline Profile where the store does not (a sideloaded build, Play before it has compiled one).
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    // Notifications: data-only messages from the platform's relay, which wake the app to fetch the words itself.
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    baselineProfile(project(":baselineprofile"))

    testImplementation("junit:junit:4.13.2")

    // The accessibility checks Accessibility Scanner runs (labels, touch targets, contrast), on every screen an instrumented
    // test acts on: src/androidTest.
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-accessibility:3.7.0")
}
