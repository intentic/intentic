package dev.intentic.app.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.ColorRes
import androidx.annotation.FontRes
import androidx.core.content.res.ResourcesCompat
import androidx.core.graphics.TypefaceCompat
import androidx.core.view.ViewCompat
import dev.intentic.app.R
import kotlin.math.roundToInt

/**
 * The screens are built in code from plain Views, with no layout files: this is the vocabulary they share. Colours
 * are the generated roles (res/values/colors.xml), type is the bundled Public Sans and JetBrains Mono.
 */
class Ui(val context: Context) {
    private val density = context.resources.displayMetrics.density

    enum class Tone { PRIMARY, SECONDARY, QUIET }

    fun dp(value: Int): Int = (value * density).roundToInt()

    fun color(@ColorRes id: Int): Int = context.getColor(id)

    fun column(vararg children: View): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            children.forEach(::addView)
        }

    fun row(vararg children: View): LinearLayout =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            children.forEach(::addView)
        }

    fun title(text: CharSequence): TextView = text(text, 26f, 600, R.color.content).apply {
        setPadding(0, 0, 0, dp(8))
        ViewCompat.setAccessibilityHeading(this, true)
    }

    /** A screen's name in its bar: one line, a heading to TalkBack. */
    fun barTitle(text: CharSequence): TextView = text(text, 17f, 600, R.color.content).apply {
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        gravity = Gravity.CENTER_VERTICAL
        ViewCompat.setAccessibilityHeading(this, true)
    }

    /** A 48dp square icon button, named for TalkBack: the smallest target a finger is promised. */
    fun iconButton(drawable: Int, label: CharSequence, onClick: (View) -> Unit): android.widget.ImageView =
        android.widget.ImageView(context).apply {
            setImageDrawable(icon(drawable, R.color.content))
            contentDescription = label
            scaleType = android.widget.ImageView.ScaleType.CENTER
            background = ripple()
            layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
            setOnClickListener(onClick)
        }

    fun lead(text: CharSequence): TextView = text(text, 17f, 400, R.color.muted).apply { setPadding(0, 0, 0, dp(24)) }

    fun body(text: CharSequence, muted: Boolean = false): TextView =
        text(text, 15f, 400, if (muted) R.color.muted else R.color.content)

    fun mono(text: CharSequence): TextView = text(text, 13f, 400, R.color.muted, R.font.jetbrains_mono)

    fun text(text: CharSequence, sp: Float, weight: Int, @ColorRes ink: Int, @FontRes font: Int = R.font.public_sans) =
        TextView(context).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            setTextColor(color(ink))
            typeface = face(font, weight)
        }

    /** A full-width button: the filled primary, an outlined secondary, or quiet text that reads as a link. */
    fun button(text: CharSequence, tone: Tone = Tone.PRIMARY, onClick: () -> Unit): TextView {
        val ink = when (tone) {
            Tone.PRIMARY -> R.color.fill_content
            Tone.SECONDARY -> R.color.content
            Tone.QUIET -> R.color.link
        }
        return text(text, 15f, if (tone == Tone.QUIET) 500 else 600, ink).apply {
            gravity = Gravity.CENTER
            minimumHeight = dp(48)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            val ground = when (tone) {
                Tone.PRIMARY -> surface(R.color.primary_fill)
                Tone.SECONDARY -> surface(R.color.card, stroke = R.color.line_strong)
                Tone.QUIET -> null
            }
            background = RippleDrawable(ColorStateList.valueOf(color(R.color.primary_tint)), ground, ground ?: surface(R.color.content))
            isClickable = true
            isFocusable = true
            setOnClickListener { onClick() }
        }
    }

    /** A text field on the design system's well: the card's fill inside the strong rule. */
    fun field(hint: CharSequence, type: Int = InputType.TYPE_CLASS_TEXT): EditText =
        EditText(context).apply {
            this.hint = hint
            inputType = type
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(color(R.color.content))
            setHintTextColor(color(R.color.subtle))
            typeface = face(R.font.public_sans, 400)
            isSingleLine = true
            // The view's own minimum, not TextView's: setting single line (or lines at all) replaces TextView's, and the
            // field came out a pixel short of the 48dp a target is promised.
            minimumHeight = dp(48)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = surface(R.color.card, stroke = R.color.line_strong)
        }

    /** A rounded fill, optionally ringed: the one shape every surface here is cut from. */
    fun surface(@ColorRes fill: Int, radius: Int = 10, @ColorRes stroke: Int? = null): GradientDrawable =
        GradientDrawable().apply {
            setColor(color(fill))
            cornerRadius = dp(radius).toFloat()
            stroke?.let { setStroke(dp(1), color(it)) }
        }

    fun dot(@ColorRes fill: Int, size: Int = 8): View =
        View(context).apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(color(fill))
            }
            layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
        }

    /** The press feedback of a row that is not a button: the accent's tint, spreading from the touch. */
    fun ripple(): Drawable = RippleDrawable(ColorStateList.valueOf(color(R.color.primary_tint)), null, ColorDrawable(Color.WHITE))

    fun icon(drawable: Int, @ColorRes tint: Int): Drawable =
        requireNotNull(context.getDrawable(drawable)).mutate().apply { setTint(color(tint)) }

    /** Margins for a child of a vertical column. */
    fun spaced(view: View, top: Int = 0, bottom: Int = 0): View =
        view.apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(top)
                bottomMargin = dp(bottom)
            }
        }

    // TypefaceCompat picks a weight out of a font family on API 26-27 too, where Typeface.create(family, weight) is
    // missing.
    fun face(@FontRes font: Int, weight: Int): Typeface = TypefaceCompat.create(context, ResourcesCompat.getFont(context, font), weight, false)
}
