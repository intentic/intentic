package dev.intentic.app

import android.app.Activity
import android.os.Bundle
import dev.intentic.app.ui.Looks

/**
 * Preview builds only. Sets the app's own look for screens opened after it, leaving the phone's setting alone and keeping
 * nothing: `adb shell am start -n dev.intentic.app.bench/dev.intentic.app.PreviewLook --es theme dark` (or `light`,
 * `sanctum`, or `system` to follow the phone).
 */
class PreviewLook : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Looks.choose(intent.getStringExtra("theme") ?: "system", null)
        finish()
    }
}
