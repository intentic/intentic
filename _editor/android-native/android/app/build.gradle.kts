import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.OutputDirectory

plugins {
    id("com.android.application")
}

android {
    namespace = "dev.intentic.spike"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.intentic.spike"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            // arm64 for a phone, x86_64 for the emulator the spike is checked on.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // A spike is installed by hand on test phones: the debug key is enough, and a release build is what is measured.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// The Rust core, built for both ABIs by cargo-ndk into a directory the variant reads its native libraries from.
abstract class CargoNdk : Exec() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val core: File = rootProject.projectDir.resolve("../core").canonicalFile

val cargoNdk = tasks.register<CargoNdk>("cargoNdk") {
    outputDir.set(layout.buildDirectory.dir("rust/jniLibs"))
    inputs.dir(core.resolve("src"))
    inputs.file(core.resolve("Cargo.toml"))
    workingDir = core
    executable = "cargo"
    argumentProviders.add(CommandLineArgumentProvider {
        listOf("ndk", "-t", "arm64-v8a", "-t", "x86_64", "-P", "26", "-o", outputDir.get().asFile.path, "build", "--release", "--features", "surface")
    })
}

// The shared fixture, the only file of ../../fixture the app carries.
abstract class FixtureAssets : Sync() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val fixtureAssets = tasks.register<FixtureAssets>("fixtureAssets") {
    outputDir.set(layout.buildDirectory.dir("generated/fixture"))
    from(rootProject.projectDir.resolve("../fixture/soft-deletes.json"))
    into(outputDir)
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(cargoNdk, CargoNdk::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(fixtureAssets, FixtureAssets::outputDir)
    }
}

dependencies {
    implementation("androidx.core:core:1.19.1")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    // Installs the baseline profile a release build carries, so a first start runs compiled code where it can.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
}
