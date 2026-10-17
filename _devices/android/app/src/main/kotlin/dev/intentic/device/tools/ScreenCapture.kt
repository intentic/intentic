package dev.intentic.device.tools

/** How a screenshot is taken on this phone right now, as `facts.access.screenCapture` says it. */
object ScreenCapture {
    /** The first Android release where an accessibility service can take a screenshot itself (AccessibilityService.takeScreenshot). */
    const val ACCESSIBILITY_SCREENSHOT_SDK = 30

    /**
     * "accessibility": the bound touch service takes it with no prompt. "consent": the person approves each screen-sharing
     * session. "none" on a [watch] without the touch service: Wear OS has no screen-sharing dialog to approve one with.
     */
    fun mode(accessibilityBound: Boolean, sdk: Int, watch: Boolean = false): String =
        when {
            accessibilityBound && sdk >= ACCESSIBILITY_SCREENSHOT_SDK -> "accessibility"
            watch -> "none"
            else -> "consent"
        }

    /** What a screenshot answers on a watch with no touch service, since there is no prompt to put on its screen. */
    const val WATCH_NEEDS_TOUCH =
        "A watch has no screen-sharing prompt: screenshots need the touch service, which the person switches on in the watch's Settings, under Accessibility."
}
