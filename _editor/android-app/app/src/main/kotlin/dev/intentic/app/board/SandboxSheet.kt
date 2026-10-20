package dev.intentic.app.board

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import dev.intentic.app.R
import dev.intentic.app.core.SandboxRow
import dev.intentic.app.ui.Ui

/**
 * The sandbox switcher: a sheet up from the bottom listing every sandbox the account can open, the open one ticked.
 * A plain Dialog rather than Material's bottom sheet, which would bring the Material Components theme with it.
 */
class SandboxSheet(private val activity: Activity, private val pick: (SandboxRow) -> Unit) {
    private val ui = Ui(activity)

    fun show(sandboxes: List<SandboxRow>, open: String?) {
        val dialog = Dialog(activity)
        val list = ui.column(ui.text(activity.getString(R.string.sandbox_sandbox_switcher_sandboxes), 13f, 600, R.color.muted).apply {
            setPadding(ui.dp(20), ui.dp(20), ui.dp(20), ui.dp(8))
        })
        for (sandbox in sandboxes) {
            list.addView(row(sandbox, sandbox.id == open) {
                dialog.dismiss()
                if (sandbox.id != open) pick(sandbox)
            })
        }
        list.setPadding(0, 0, 0, ui.dp(24))
        list.background = GradientDrawable().apply {
            setColor(ui.color(R.color.overlay))
            val radius = ui.dp(16).toFloat()
            cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
        }
        dialog.setContentView(ScrollView(activity).apply { addView(list) })
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setGravity(Gravity.BOTTOM)
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setWindowAnimations(android.R.style.Animation_InputMethod)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        }
        dialog.show()
    }

    private fun row(sandbox: SandboxRow, isOpen: Boolean, onClick: () -> Unit): View {
        val name = ui.text(sandbox.name, 16f, if (isOpen) 600 else 500, R.color.content)
        val meta = listOfNotNull(sandbox.role, activity.getString(R.string.settings_settings_billing_machine_asleep).takeIf { sandbox.asleep })
        val text = ui.column(name, ui.text(meta.joinToString(" · "), 13f, 400, R.color.muted)).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val tick = ImageView(activity).apply {
            setImageDrawable(ui.icon(R.drawable.ic_check, R.color.accent))
            visibility = if (isOpen) View.VISIBLE else View.INVISIBLE
        }
        return ui.row(text, tick).apply {
            minimumHeight = ui.dp(56)
            setPadding(ui.dp(20), ui.dp(10), ui.dp(20), ui.dp(10))
            background = ui.ripple()
            isClickable = true
            setOnClickListener { onClick() }
        }
    }
}
