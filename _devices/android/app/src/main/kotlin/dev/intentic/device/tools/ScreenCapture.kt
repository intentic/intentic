package dev.intentic.device.tools

/** How a screenshot is taken on this phone right now, as `facts.access.screenCapture` says it. */
object ScreenCapture {
    /** The first Android release where an accessibility service can take a screenshot itself (AccessibilityService.takeScreenshot). */
    const val ACCESSIBILITY_SCREENSHOT_SDK = 30

    /** "accessibility": the bound touch service takes it with no prompt. "consent": the person approves each screen-sharing session. */
    fun mode(accessibilityBound: Boolean, sdk: Int): String = if (accessibilityBound && sdk >= ACCESSIBILITY_SCREENSHOT_SDK) "accessibility" else "consent"
}
