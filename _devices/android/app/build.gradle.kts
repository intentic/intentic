import java.io.File

plugins {
    id("com.android.application")
}

// Firebase Cloud Messaging is configured from Gradle properties, never from google-services.json. All four empty means
// the build never starts Firebase (see FirebaseSupport.kt).
fun fcm(name: String): String = providers.gradleProperty("intentic.fcm.$name").orElse("").get().trim()

android {
    namespace = "dev.intentic.device"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.intentic.device"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("intentic.versionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("intentic.versionName").orElse("0.1.0").get()

        buildConfigField("String", "FCM_API_KEY", "\"${fcm("apiKey")}\"")
        buildConfigField("String", "FCM_APP_ID", "\"${fcm("appId")}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${fcm("projectId")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${fcm("senderId")}\"")
    }

    // `direct` is the build downloaded from intentic.dev: it updates itself and is where the accessibility service will
    // live. `play` is the store build, which never carries either. The flavor name is what the phone reports as `build`.
    flavorDimensions += "distribution"
    productFlavors {
        create("direct") {
            dimension = "distribution"
            buildConfigField("String", "DISTRIBUTION", "\"direct\"")
        }
        create("play") {
            dimension = "distribution"
            buildConfigField("String", "DISTRIBUTION", "\"play\"")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests {
            // The protocol layer only touches org.json and the JDK; this keeps an incidental android.* call from
            // throwing in a test instead of returning a default.
            isReturnDefaultValues = true
        }
    }
}

// The wire examples the sandbox and this app both test against; the unit tests read them from here.
val goldenWire: File = rootProject.projectDir.resolve("../../_shared/sandbox-contract/golden/phone-wire.json").canonicalFile

tasks.withType<Test>().configureEach {
    systemProperty("intentic.golden.phoneWire", goldenWire.path)
}

dependencies {
    implementation("androidx.core:core:1.19.1")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.activity:activity:1.13.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")

    // Optional wake-up push; initialized from BuildConfig only when its four properties are set.
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")

    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub in unit tests; the real library sits ahead of it on the test classpath.
    testImplementation("org.json:json:20260814")
}
