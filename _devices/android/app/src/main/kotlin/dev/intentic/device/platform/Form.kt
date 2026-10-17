package dev.intentic.device.platform

import android.content.Context
import android.content.pm.PackageManager

/**
 * What kind of device the app runs on. One APK serves phones and Wear OS watches; a watch has no folders to pick (Wear
 * OS has no document picker), no notification-access screen, no Quick Settings tile and no camera, so the app shows a
 * round screen of its own there and answers fewer tools.
 */
enum class Form(val key: String, val noun: String) {
    PHONE("phone", "phone"),
    WATCH("watch", "watch"),
    ;

    companion object {
        fun of(context: Context): Form = if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_WATCH)) WATCH else PHONE
    }
}
