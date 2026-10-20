// Times the app on a phone with Macrobenchmark: a cold start to the first frame with rows (reportFullyDrawn), and the
// frames of a conversation's scrolling and streaming, each without the Baseline Profile (CompilationMode.None: only the
// JIT) and with it (Partial, profile required). Against the `bench` build, the same one the spike's bench measures:
//
//   ANDROID_SERIAL=<phone> bash scripts/gradle.sh :benchmark:connectedBenchAndroidTest
//
// Results: benchmark/build/outputs/connected_android_test_additional_output/benchAndroidTest/connected/<device>/*.json,
// and the summary the run prints.
plugins {
    id("com.android.test")
}

android {
    namespace = "dev.intentic.app.benchmark"
    compileSdk = 37

    defaultConfig {
        minSdk = 29
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        // Matches the app's `bench`. Debuggable here is only the test's own APK, which runs in a process of its own.
        create("bench") {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }

    targetProjectPath = ":app"
    // The test APK drives the app from its own process, as a person's touches would.
    experimentalProperties["android.experimental.self-instrumenting"] = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents {
    beforeVariants { it.enable = it.buildType == "bench" }
    // The id of the build being timed (dev.intentic.app.bench), for the benchmarks to launch.
    onVariants { variant ->
        val loader = variant.artifacts.getBuiltArtifactsLoader()
        variant.instrumentationRunnerArguments.put("targetAppId", variant.testedApks.map { loader.load(it)?.applicationId ?: "" })
    }
}

dependencies {
    implementation("androidx.test.ext:junit:1.3.0")
    implementation("androidx.test.uiautomator:uiautomator:2.4.0")
    implementation("androidx.benchmark:benchmark-macro-junit4:1.5.0")
}
