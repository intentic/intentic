package dev.intentic.device.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import dev.intentic.device.BuildConfig
import dev.intentic.device.Distribution
import dev.intentic.device.Graph
import dev.intentic.device.R
import dev.intentic.device.link.LinkState
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppMode
import dev.intentic.device.store.LinkMode

/**
 * The owner's side on a Wear OS watch: [MainActivity]'s screen cut to what a watch has. Pairing (which arrives from the
 * phone, since a watch cannot scan a code), the pause switch, the access Android has to give, the apps the agent may
 * use, and unpairing. There are no folders (Wear OS has no document picker) and no notification access (no screen to
 * switch it on with). Every line is centred and the list is turned with the crown.
 */
class WatchActivity : AppCompatActivity() {
    private lateinit var ui: Ui
    private lateinit var content: LinearLayout
    private lateinit var scroll: ScrollView
    private val observer: () -> Unit = { render() }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_IntenticDevice_Watch)
        super.onCreate(savedInstanceState)
        ui = Ui(this, compact = true)
        content = ui.column()
        scroll = ui.watchScreen(this, content)
        setContentView(scroll)
    }

    override fun onStart() {
        super.onStart()
        Graph.changes.add(observer)
        // Opening the app is a reason to connect, as on a phone.
        Graph.connect(this)
        Distribution.updates?.check()
    }

    override fun onResume() {
        super.onResume()
        render()
        // The crown scrolls whatever has focus.
        scroll.requestFocus()
    }

    override fun onStop() {
        Graph.changes.remove(observer)
        super.onStop()
    }

    private fun render() {
        content.removeAllViews()
        content.addView(ui.title("Intentic"))
        val pairing = Graph.pairings.get()
        if (pairing == null) {
            content.addView(ui.body("Not paired yet."))
            content.addView(
                ui.body(
                    "Add a Wear OS watch on your sandbox's Capabilities page, then scan its code with your phone's camera. " +
                        "Intentic Device on the phone sends it here, and this watch asks you before it pairs.",
                    muted = true,
                ),
            )
            content.addView(ui.button("Enter a code") { startActivity(Intent(this, PairActivity::class.java)) })
            aboutSection()
            return
        }
        content.addView(ui.body(statusText()))
        content.addView(ui.body(Graph.hostOf(pairing.sandboxUrl), muted = true))
        content.addView(
            ui.button(if (Graph.settings.paused) "Resume the agent" else "Pause the agent") {
                Graph.settings.paused = !Graph.settings.paused
            },
        )
        accessSection()
        appsSection()
        connectionSection()
        content.addView(ui.heading("Unpair"))
        content.addView(ui.button("Unpair this watch") { confirmUnpair() })
        aboutSection()
    }

    private fun statusText(): String =
        when {
            Graph.settings.paused -> "Paused. Every request is refused."
            Graph.link.state == LinkState.CONNECTED -> "Connected"
            Graph.link.state == LinkState.CONNECTING -> "Connecting..."
            Graph.link.state == LinkState.WAITING -> "Waiting for your sandbox."
            Graph.settings.mode == LinkMode.ON_DEMAND -> "Asleep. It connects when your agent needs the watch."
            else -> "Not connected."
        }

    // --- access Android has to give ----------------------------------------------------------------------------------

    private fun accessSection() {
        content.addView(ui.heading("Access"))
        if (Graph.notifier.noticeVisible()) {
            content.addView(ui.body("Notifications: allowed.", muted = true))
        } else {
            content.addView(ui.body("Notifications: not allowed. Your agent is refused until they are, so you always see when it is connected."))
            content.addView(ui.button("Allow") {
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            })
        }
        Distribution.accessRows(this, ui, content)
    }

    // --- apps --------------------------------------------------------------------------------------------------------

    private fun appsSection() {
        content.addView(ui.heading("Apps"))
        for (request in Graph.requests.all()) {
            val verb = if (request.mode == AppMode.READ) "look at" else "act in"
            content.addView(ui.body("Your agent asks to $verb ${request.label}: ${request.reason.ifBlank { "no reason given" }}"))
            content.addView(ui.button("Allow") {
                Graph.requests.remove(request.pkg, request.mode)
                Graph.notifier.cancelAccess(request.pkg, request.mode)
                Graph.allowList.put(AllowedApp(request.pkg, Graph.apps.find(request.pkg)?.label ?: request.label, request.mode, sensitive = false))
                Graph.log.event("The owner allowed the agent to $verb ${request.label}")
                Graph.changes.fire()
            })
            content.addView(ui.button("Deny") {
                Graph.requests.remove(request.pkg, request.mode)
                Graph.requests.deny(request.pkg, request.mode)
                Graph.notifier.cancelAccess(request.pkg, request.mode)
                Graph.log.event("The owner said no to the agent asking to $verb ${request.label}")
                Graph.changes.fire()
            })
        }
        val allowed = Graph.allowList.all()
        if (allowed.isEmpty() && Graph.requests.all().isEmpty()) {
            content.addView(ui.body("None yet. Your agent may look at or act in only the apps you add.", muted = true))
        }
        for (app in allowed) {
            val mode = if (app.mode == AppMode.ACT) "look and act" else "look only"
            content.addView(ui.button("${app.label}: $mode${if (app.sensitive) ", sensitive" else ""}") { changeApp(app) })
        }
        content.addView(ui.button("Add an app") { chooseApp() })
    }

    private fun changeApp(app: AllowedApp) {
        val choices = arrayOf(
            if (app.mode == AppMode.ACT) "Look only" else "Look and act",
            if (app.sensitive) "Not sensitive" else "Sensitive: ask every time",
            "Remove",
        )
        AlertDialog.Builder(this)
            .setTitle(app.label)
            .setItems(choices) { _, choice ->
                when (choice) {
                    0 -> Graph.allowList.put(app.copy(mode = if (app.mode == AppMode.ACT) AppMode.READ else AppMode.ACT))
                    1 -> Graph.allowList.put(app.copy(sensitive = !app.sensitive))
                    else -> {
                        Graph.allowList.remove(app.pkg)
                        Graph.log.event("Removed ${app.label} from the apps the agent may use")
                    }
                }
                Graph.changes.fire()
            }
            .show()
    }

    private fun chooseApp() {
        val installed = Graph.apps.launchable().sortedBy { it.label.lowercase() }
        AlertDialog.Builder(this)
            .setTitle("Which app?")
            .setItems(installed.map { it.label }.toTypedArray()) { _, index ->
                val app = installed[index]
                AlertDialog.Builder(this)
                    .setTitle(app.label)
                    .setItems(arrayOf("Look only", "Look and act")) { _, choice ->
                        Graph.allowList.put(AllowedApp(app.pkg, app.label, if (choice == 1) AppMode.ACT else AppMode.READ, sensitive = false))
                        Graph.log.event("Allowed the agent ${if (choice == 1) "to act in" else "to look at"} ${app.label}")
                        Graph.changes.fire()
                    }
                    .show()
            }
            .show()
    }

    // --- connection, unpair, about -----------------------------------------------------------------------------------

    private fun connectionSection() {
        content.addView(ui.heading("Connection"))
        content.addView(Switch(this).apply {
            text = "Stay connected"
            isChecked = Graph.settings.mode == LinkMode.STAY
            setOnCheckedChangeListener { _, stay ->
                val mode = if (stay) LinkMode.STAY else LinkMode.ON_DEMAND
                if (mode != Graph.settings.mode) {
                    Graph.settings.mode = mode
                    Graph.log.event(if (stay) "Set to stay connected" else "Set to connect on demand")
                    Graph.link.settingsChanged()
                    Graph.connect(this@WatchActivity)
                }
            }
        })
        content.addView(ui.body("Off, it connects only when your agent needs the watch, which saves its battery.", muted = true))
        content.addView(ui.button("Activity") { startActivity(Intent(this, ActivityLogActivity::class.java)) })
    }

    private fun confirmUnpair() {
        val host = Graph.pairings.get()?.sandboxUrl?.let { Graph.hostOf(it) } ?: return
        AlertDialog.Builder(this)
            .setTitle("Unpair from $host?")
            .setMessage("Your agent loses this watch and the apps you allowed are cleared.")
            .setPositiveButton("Unpair") { _, _ -> Graph.unpair("The owner unpaired this watch") }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun aboutSection() {
        content.addView(ui.heading("About"))
        content.addView(ui.body("Version ${BuildConfig.VERSION_NAME}, ${BuildConfig.DISTRIBUTION} build.", muted = true))
        val updates = Distribution.updates ?: return
        val label = updates.availableLabel()
        if (label != null) {
            content.addView(ui.button(label) { updates.install(this) })
        }
    }
}
