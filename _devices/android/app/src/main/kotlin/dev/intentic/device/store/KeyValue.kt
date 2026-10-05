package dev.intentic.device.store

/** The few typed reads and writes the phone's stores need from key-value storage; SharedPreferences in the app, a map in a test. */
interface KeyValue {
    fun getString(key: String): String?

    /** A null value removes the key. */
    fun putString(key: String, value: String?)

    fun getBoolean(key: String, default: Boolean): Boolean

    fun putBoolean(key: String, value: Boolean)

    fun getLong(key: String, default: Long): Long

    fun putLong(key: String, value: Long)
}
