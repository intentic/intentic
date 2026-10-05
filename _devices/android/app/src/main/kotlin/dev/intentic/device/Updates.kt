package dev.intentic.device

import android.app.Activity

/** What the About screen shows of the self-updater. Only the `direct` build has one; the `play` build leaves it to the store. */
interface Updates {
    /** One line: "Up to date", "Version 0.2.0 is available", "Checking...". */
    fun status(): String

    /** Looks for a newer version now. Quiet when it cannot reach the server. */
    fun check()

    /** A label for the install button when a newer version waits, else null. */
    fun availableLabel(): String?

    /** Downloads the newer version, checks it, and hands it to Android's installer, which asks the owner to confirm. */
    fun install(activity: Activity)
}
