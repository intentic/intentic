package dev.intentic.device.ui

import android.os.Bundle
import android.widget.ScrollView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.intentic.device.Graph
import java.text.DateFormat
import java.util.Date

/** What the agent did on this phone, newest first: the last 100 things. */
class ActivityLogActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Activity"
        val ui = Ui(this)
        val content = ui.column().apply { setPadding(ui.dp(16), ui.dp(8), ui.dp(16), ui.dp(16)) }
        val entries = Graph.log.last()
        if (entries.isEmpty()) {
            content.addView(ui.body("Nothing yet. What your agent does on this phone will be listed here."))
        } else {
            content.addView(ui.body("The last ${entries.size}, newest first. Text it sent to be typed or written is cut short here.", muted = true))
        }
        val format = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM)
        for (entry in entries) {
            val text = if (entry.tool == null) {
                "${format.format(Date(entry.time))}\n${entry.text}"
            } else {
                "${format.format(Date(entry.time))}\n${entry.tool} ${entry.args.orEmpty()}\n${entry.text}"
            }
            content.addView(ui.mono(text))
        }
        val scroll = ScrollView(this).apply { addView(content) }
        setContentView(scroll)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, 0, bars.right, bars.bottom)
            insets
        }
    }
}
