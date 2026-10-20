import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.OutputDirectory

plugins {
    id("com.android.application")
}

// `-Pjna=false` leaves JNA and the modes that use it out: the build `scripts/apk-size.sh` weighs the full one against.
val withJna = providers.gradleProperty("jna").getOrElse("true") != "false"

android {
    namespace = "dev.intentic.bridgebench"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.intentic.bridgebench"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            // arm64 for a phone, x86_64 for an emulator.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Installed by hand on test phones: the debug key is enough, and a release build is what is measured.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets.getByName("main").kotlin.srcDir(if (withJna) "src/jna/kotlin" else "src/nojna/kotlin")
}

// The Rust library, built for both ABIs by cargo-ndk into a directory the variant reads its native libraries from.
abstract class CargoNdk : Exec() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val crate: File = rootProject.projectDir.resolve("..").canonicalFile

val cargoNdk = tasks.register<CargoNdk>("cargoNdk") {
    outputDir.set(layout.buildDirectory.dir("rust/jniLibs"))
    inputs.dir(crate.resolve("src"))
    inputs.file(crate.resolve("Cargo.toml"))
    workingDir = crate
    executable = "cargo"
    argumentProviders.add(CommandLineArgumentProvider {
        listOf("ndk", "-t", "arm64-v8a", "-t", "x86_64", "-P", "26", "-o", outputDir.get().asFile.path, "build", "--release")
    })
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(cargoNdk, CargoNdk::outputDir)
    }
}

dependencies {
    if (withJna) {
        // What UniFFI's Kotlin bindings call through; the AAR carries libjnidispatch.so for each ABI.
        implementation("net.java.dev.jna:jna:5.19.1@aar")
    }
}
