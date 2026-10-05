package dev.intentic.device.touch

import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction

/** A node of the screen's accessibility tree, as [UiNode]. What the tools do to a node, they do through Android's own accessibility actions. */
class NodeAdapter(private val info: AccessibilityNodeInfo) : UiNode {
    override val packageName: String? get() = info.packageName?.toString()
    override val className: String? get() = info.className?.toString()
    override val text: CharSequence? get() = info.text
    override val contentDescription: CharSequence? get() = info.contentDescription
    override val hintText: CharSequence? get() = info.hintText
    override val bounds: Bounds
        get() {
            val rect = Rect()
            info.getBoundsInScreen(rect)
            return Bounds(rect.left, rect.top, rect.right, rect.bottom)
        }
    override val isVisibleToUser: Boolean get() = info.isVisibleToUser
    override val isClickable: Boolean get() = info.isClickable
    override val isLongClickable: Boolean get() = info.isLongClickable
    override val isEditable: Boolean get() = info.isEditable
    override val isFocusable: Boolean get() = info.isFocusable
    override val isFocused: Boolean get() = info.isFocused
    override val isCheckable: Boolean get() = info.isCheckable
    override val isChecked: Boolean get() = info.isChecked
    override val isEnabled: Boolean get() = info.isEnabled
    override val isScrollable: Boolean get() = info.isScrollable
    override val isPassword: Boolean get() = info.isPassword
    override val isShowingHint: Boolean get() = info.isShowingHintText
    override val parent: UiNode? get() = info.parent?.let(::NodeAdapter)
    override val children: List<UiNode>
        get() = (0 until info.childCount).mapNotNull { index -> info.getChild(index)?.let(::NodeAdapter) }

    override fun refresh(): Boolean = info.refresh()

    override fun click(): Boolean = info.performAction(AccessibilityNodeInfo.ACTION_CLICK)

    override fun longClick(): Boolean = info.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)

    override fun setText(text: String): Boolean {
        val arguments = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        return info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    override fun requestFocus(): Boolean = info.performAction(AccessibilityNodeInfo.ACTION_FOCUS)

    override fun scroll(direction: ScrollDirection): Boolean {
        val action = when (direction) {
            ScrollDirection.UP -> AccessibilityAction.ACTION_SCROLL_UP
            ScrollDirection.DOWN -> AccessibilityAction.ACTION_SCROLL_DOWN
            ScrollDirection.LEFT -> AccessibilityAction.ACTION_SCROLL_LEFT
            ScrollDirection.RIGHT -> AccessibilityAction.ACTION_SCROLL_RIGHT
        }
        return info.actionList.contains(action) && info.performAction(action.id)
    }
}
