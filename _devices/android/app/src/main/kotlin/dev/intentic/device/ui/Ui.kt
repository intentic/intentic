package dev.intentic.device.ui

import android.content.Context
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.app.Activity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * A few helpers so the screens are built in code with plain Views and no layout files. [compact] is a watch's: smaller
 * type, centred, for a screen a few centimetres across.
 */
class Ui(private val context: Context, private val compact: Boolean = false) {
    private val density = context.resources.displayMetrics.density

    fun dp(value: Int): Int = (value * density).toInt()

    fun column(): LinearLayout = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    fun title(text: String): TextView =
        TextView(context).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compact) 17f else 22f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(if (compact) 4 else 8), 0, dp(4))
            if (compact) gravity = Gravity.CENTER_HORIZONTAL
        }

    fun heading(text: String): TextView =
        TextView(context).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compact) 14f else 17f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(if (compact) 14 else 24), 0, dp(if (compact) 4 else 6))
            if (compact) gravity = Gravity.CENTER_HORIZONTAL
        }

    fun body(text: String, muted: Boolean = false): TextView =
        TextView(context).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compact) 13f else 15f)
            setPadding(0, dp(2), 0, dp(2))
            if (muted) alpha = 0.7f
            if (compact) gravity = Gravity.CENTER_HORIZONTAL
        }

    fun mono(text: String): TextView =
        TextView(context).apply {
            this.text = text
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(3), 0, dp(3))
        }

    fun button(text: String, onClick: () -> Unit): Button =
        Button(context).apply {
            this.text = text
            isAllCaps = false
            setOnClickListener { onClick() }
        }

    /** A line of text on the left and a button on the right. */
    fun action(text: String, label: String, onClick: () -> Unit): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(body(text), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(button(label, onClick))
        }

    /**
     * A watch screen: [content] in a scroll view that the crown turns, padded so nothing sits in the corners a round
     * screen cuts off.
     */
    fun watchScreen(activity: Activity, content: LinearLayout): ScrollView {
        val metrics = activity.resources.displayMetrics
        val round = activity.resources.configuration.isScreenRound
        val side = (metrics.widthPixels * if (round) 0.12f else 0.04f).toInt()
        content.setPadding(side, (metrics.heightPixels * if (round) 0.16f else 0.04f).toInt(), side, (metrics.heightPixels * 0.22f).toInt())
        return ScrollView(activity).apply {
            isVerticalScrollBarEnabled = true
            isFocusable = true
            isFocusableInTouchMode = true
            addView(content)
        }
    }
}
