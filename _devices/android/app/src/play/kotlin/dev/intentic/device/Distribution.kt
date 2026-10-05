package dev.intentic.device

import android.app.Activity
import android.app.Application
import android.widget.LinearLayout
import dev.intentic.device.tools.ScreenPort
import dev.intentic.device.tools.Tool
import dev.intentic.device.tools.ToolDeps
import dev.intentic.device.ui.Ui

/**
 * What the `play` build adds to the common app: nothing. It never updates itself (the store does), never asks for the
 * permission to install packages, and carries no accessibility service, which Google Play does not allow an agent to
 * drive other apps through: no touch tools are listed, the facts say the service is off, and screenshots always ask the
 * person. The `direct` build's Distribution is where those live.
 */
object Distribution {
    val updates: Updates? = null

    /** The tool families this build answers beyond the common ones. */
    val features: List<String> = emptyList()

    fun start(app: Application) = Unit

    /** Tools this flavor adds to the common ones. None, and none ever, in this flavor. */
    fun tools(deps: ToolDeps): List<Tool> = emptyList()

    /** There is no accessibility service in this build. */
    fun accessibilityBound(): Boolean = false

    /** Screenshots go through the screen-sharing session the person approves, and nothing else. */
    fun screen(projection: ScreenPort): ScreenPort = projection

    /** No rows of its own in "Access on this phone". */
    fun accessRows(activity: Activity, ui: Ui, content: LinearLayout) = Unit
}
