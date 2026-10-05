package dev.intentic.device.store

import android.content.SharedPreferences

/** [KeyValue] over the app's private SharedPreferences. Writes are applied in the background. */
class PrefsKeyValue(private val prefs: SharedPreferences) : KeyValue {
    override fun getString(key: String): String? = prefs.getString(key, null)

    override fun putString(key: String, value: String?) {
        prefs.edit().also { if (value == null) it.remove(key) else it.putString(key, value) }.apply()
    }

    override fun getBoolean(key: String, default: Boolean): Boolean = prefs.getBoolean(key, default)

    override fun putBoolean(key: String, value: Boolean) {
        prefs.edit().putBoolean(key, value).apply()
    }

    override fun getLong(key: String, default: Long): Long = prefs.getLong(key, default)

    override fun putLong(key: String, value: Long) {
        prefs.edit().putLong(key, value).apply()
    }
}
