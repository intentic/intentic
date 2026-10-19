plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.intentic.spike.compose"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.intentic.spike.compose"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // A spike is installed by hand on test phones: the debug key is enough, and a release build is what is measured.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// The shared fixture, the only file of ../../fixture the app carries.
abstract class FixtureAssets : Sync() {
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val fixture: File = rootProject.projectDir.resolve("../fixture/soft-deletes.json").canonicalFile

val fixtureAssets = tasks.register<FixtureAssets>("fixtureAssets") {
    outputDir.set(layout.buildDirectory.dir("generated/fixture"))
    from(fixture)
    into(outputDir)
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(fixtureAssets, FixtureAssets::outputDir)
    }
}

// The unit tests read the same fixture from where it lives.
tasks.withType<Test>().configureEach {
    systemProperty("spike.fixture", fixture.path)
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.46.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-code:0.46.0")
    // Installs the baseline profiles the libraries ship, so a first start runs compiled code where it can.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")

    testImplementation("junit:junit:4.13.2")
}
