package dev.intentic.device.touch

import kotlin.math.max

/** A rectangle in phone pixels. */
data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val centerX: Int get() = (left + right) / 2
    val centerY: Int get() = (top + bottom) / 2
    val isEmpty: Boolean get() = width <= 0 || height <= 0
    val area: Long get() = max(0, width).toLong() * max(0, height)

    fun contains(x: Int, y: Int): Boolean = x >= left && x < right && y >= top && y < bottom
}

enum class ScrollDirection { UP, DOWN, LEFT, RIGHT }

/**
 * One node of the screen's accessibility tree, as the tools need it. AccessibilityNodeInfo sits behind this in the app
 * (NodeAdapter); a plain class stands in for it in a test, so listing, refs and the rules around them run without a phone.
 * Everything here is what ANOTHER APP put on the screen: it is read, never trusted.
 */
interface UiNode {
    val packageName: String?
    val className: String?
    val text: CharSequence?
    val contentDescription: CharSequence?
    val hintText: CharSequence?
    val bounds: Bounds
    val isVisibleToUser: Boolean
    val isClickable: Boolean
    val isLongClickable: Boolean
    val isEditable: Boolean
    val isFocusable: Boolean
    val isFocused: Boolean
    val isCheckable: Boolean
    val isChecked: Boolean
    val isEnabled: Boolean
    val isScrollable: Boolean

    /** A password field: its text is never read, listed or logged. */
    val isPassword: Boolean

    /** The text shown is the field's hint, not what the person typed. */
    val isShowingHint: Boolean
    val parent: UiNode?
    val children: List<UiNode>

    /** Re-reads the node from the screen; false when it is gone. */
    fun refresh(): Boolean

    fun click(): Boolean

    fun longClick(): Boolean

    fun setText(text: String): Boolean

    fun requestFocus(): Boolean

    /** Scrolls the node's own content one page in [direction], by the accessibility action. False when the node does not scroll that way. */
    fun scroll(direction: ScrollDirection): Boolean
}
