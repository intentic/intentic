package dev.intentic.app.ui

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.doOnAttach
import androidx.core.view.WindowInsetsCompat

/**
 * Pads this view by the system bars and the display cutout on the sides asked for, on top of its own padding. The
 * window is edge to edge, so this is how a screen keeps its content clear of them. While the keyboard is up the bottom
 * bar is under it, and [fitKeyboard] has already lifted the whole screen above both.
 */
fun View.padForBars(top: Boolean = true, bottom: Boolean = true) {
    val left = paddingLeft
    val start = paddingTop
    val right = paddingRight
    val end = paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val typing = insets.isVisible(WindowInsetsCompat.Type.ime())
        view.setPadding(
            left + bars.left,
            start + if (top) bars.top else 0,
            right + bars.right,
            end + if (bottom && !typing) bars.bottom else 0,
        )
        insets
    }
    // A view added after the window's insets went round would wait for the next change (the keyboard, a rotation)
    // before it is padded at all: ask again once it is in the window.
    doOnAttach { it.requestApplyInsets() }
}

/**
 * Shrinks this root by the keyboard's height while it is up. An edge-to-edge window is no longer resized for the
 * keyboard (adjustResize stops applying), so the root does it: a scrolling screen then shrinks with it and brings the
 * focused field into view, as it would in a resized window.
 */
fun View.fitKeyboard() {
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
        view.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
        insets
    }
}
