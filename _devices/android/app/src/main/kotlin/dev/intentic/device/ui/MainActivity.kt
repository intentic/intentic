package dev.intentic.device.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Switch
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.intentic.device.BuildConfig
import dev.intentic.device.Distribution
import dev.intentic.device.Graph
import dev.intentic.device.link.LinkState
import dev.intentic.device.platform.SafFiles
import dev.intentic.device.store.AllowedApp
import dev.intentic.device.store.AppMode
import dev.intentic.device.store.LinkMode
import java.text.DateFormat
import java.util.Date

/**
 * The owner's side of everything: whether the phone is paired and connected, the pause switch, how the link behaves, the
 * access Android has to be given, the folders and apps the agent may use, what it did, and how to unpair. Every grant
 * made here is the phone's half of "on the sandbox card AND in the app".
 */
class MainActivity : AppCompatActivity() {
    private lateinit var ui: Ui
    private lateinit var content: LinearLayout
    private val observer: () -> Unit = { render() }
    private var pendingWritable = false

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            openNotificationSettings()
        }
        render()
    }

    private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            addFolder(uri, pendingWritable)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Intentic Device"
        ui = Ui(this)
        content = ui.column().apply { setPadding(ui.dp(16), ui.dp(8), ui.dp(16), ui.dp(32)) }
        val scroll = ScrollView(this).apply { addView(content) }
        setContentView(scroll)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, 0, bars.right, bars.bottom)
            insets
        }
    }

    override fun onStart() {
        super.onStart()
        Graph.changes.add(observer)
        // Opening the app is a reason to connect: "On demand" connects now and lets go after five quiet minutes.
        Graph.connect(this)
        Distribution.updates?.check()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    override fun onStop() {
        Graph.changes.remove(observer)
        super.onStop()
    }

    private fun render() {
        content.removeAllViews()
        content.addView(ui.title("Intentic Device"))
        content.addView(ui.body("Lets your own AI agent help on this phone, and only as far as you allow. You can pause it any time.", muted = true))
        pairingSection()
        if (Graph.pairings.get() != null) {
            agentSection()
            accessSection()
            foldersSection()
            appsSection()
            activitySection()
            content.addView(ui.heading("Unpair"))
            content.addView(ui.button("Unpair this phone") { confirmUnpair() })
        }
        aboutSection()
    }

    // --- pairing, pause, mode --------------------------------------------------------------------------------------

    private fun pairingSection() {
        content.addView(ui.heading("Pairing"))
        val pairing = Graph.pairings.get()
        if (pairing == null) {
            content.addView(ui.body("This phone is not paired with a sandbox."))
            content.addView(ui.button("Pair this phone") { startActivity(Intent(this, PairActivity::class.java)) })
            return
        }
        content.addView(ui.body("Sandbox: ${pairing.sandboxUrl}"))
        content.addView(ui.body("Card: ${pairing.id}"))
        content.addView(ui.body("Status: ${statusText()}"))
        content.addView(ui.button("Pair with a different sandbox") { startActivity(Intent(this, PairActivity::class.java)) })
    }

    private fun statusText(): String =
        when {
            Graph.settings.paused -> "Paused. Every request from your agent is refused."
            Graph.link.state == LinkState.CONNECTED -> "Connected"
            Graph.link.state == LinkState.CONNECTING -> "Connecting..."
            Graph.link.state == LinkState.WAITING -> "Waiting for your sandbox, trying again."
            Graph.settings.mode == LinkMode.ON_DEMAND -> "Asleep. It connects when your agent needs the phone, or when this app is open."
            else -> "Not connected."
        }

    private fun agentSection() {
        content.addView(ui.heading("Agent"))
        val pause = Switch(this).apply {
            text = "Pause the agent"
            isChecked = Graph.settings.paused
            setOnCheckedChangeListener { _, paused ->
                if (paused != Graph.settings.paused) {
                    Graph.settings.paused = paused
                }
            }
        }
        content.addView(pause)
        content.addView(ui.body("While paused every request is refused. The Quick Settings tile \"Intentic agent\" does the same; add it from the tile editor.", muted = true))

        content.addView(ui.body("How it connects"))
        val group = RadioGroup(this)
        val onDemand = RadioButton(this).apply { text = "On demand: connect when this app is open or your sandbox wakes the phone, and let go after 5 minutes without a request"; id = 1 }
        val stay = RadioButton(this).apply { text = "Stay connected: keep the connection up and start it again after a restart (uses more battery)"; id = 2 }
        group.addView(onDemand)
        group.addView(stay)
        group.check(if (Graph.settings.mode == LinkMode.STAY) 2 else 1)
        group.setOnCheckedChangeListener { _, checked ->
            val mode = if (checked == 2) LinkMode.STAY else LinkMode.ON_DEMAND
            if (mode != Graph.settings.mode) {
                Graph.settings.mode = mode
                Graph.log.event(if (mode == LinkMode.STAY) "Set to stay connected" else "Set to connect on demand")
                Graph.link.settingsChanged()
                Graph.connect(this)
            }
        }
        content.addView(group)
    }

    // --- access Android has to give ----------------------------------------------------------------------------------

    private fun accessSection() {
        content.addView(ui.heading("Access on this phone"))

        if (Graph.notifier.noticeVisible()) {
            content.addView(ui.body("Notifications: allowed. They show when your agent is connected and let it ask you."))
        } else {
            content.addView(ui.action("Notifications: not allowed. Your agent is refused until they are, so you always see when it is connected.", "Allow") {
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    openNotificationSettings()
                }
            })
        }

        AccessRows.notificationAccess(this, ui, content)
        Distribution.accessRows(this, ui, content)

        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (power.isIgnoringBatteryOptimizations(packageName)) {
            content.addView(ui.body("Battery: not restricted. \"Stay connected\" can keep its connection."))
        } else {
            content.addView(ui.action(
                "Battery: restricted by Android. \"Stay connected\" works best when this app is set to not be optimized.", "Open settings",
            ) { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) })
        }

        if (Graph.screen.isActive()) {
            content.addView(ui.action("Screen sharing: on. Your agent can take screenshots until you stop it.", "Stop") {
                Graph.log.event("The owner stopped screen sharing")
                Graph.screen.stop()
                render()
            })
        } else {
            content.addView(ui.body("Screen sharing: off. When your agent asks to see the screen you get a notification, and Android asks you what to share. Nothing is shared until you say so. With the touch service on, screenshots need no prompt."))
        }
    }

    private fun openNotificationSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    // --- folders -----------------------------------------------------------------------------------------------------

    private fun foldersSection() {
        content.addView(ui.heading("Folders"))
        content.addView(ui.body("Your agent can reach only the folders you pick here, and only if \"Read the folders you pick\" is on for this phone's card in your sandbox.", muted = true))
        val folders = Graph.folders.all()
        if (folders.isEmpty()) {
            content.addView(ui.body("No folders yet."))
        }
        for (folder in folders) {
            content.addView(ui.action("${folder.name}: ${if (folder.writable) "read and change" else "read only"}", "Remove") {
                Graph.folders.remove(folder.name)
                Graph.releaseFolder(folder.uri)
                Graph.log.event("Removed the folder ${folder.name}")
                Graph.changes.fire()
            })
        }
        content.addView(ui.button("Add a folder") {
            AlertDialog.Builder(this)
                .setTitle("Can your agent change files in it?")
                .setMessage("Changing files also needs \"Change files in those folders\" on for this phone's card in your sandbox. Android does not let you pick a whole storage or the Download folder itself; pick a folder inside it.")
                .setPositiveButton("Read only") { _, _ -> choose(writable = false) }
                .setNeutralButton("Read and change") { _, _ -> choose(writable = true) }
                .setNegativeButton("Cancel", null)
                .show()
        })
    }

    private fun choose(writable: Boolean) {
        pendingWritable = writable
        pickFolder.launch(null)
    }

    private fun addFolder(uri: Uri, writable: Boolean) {
        if (Graph.folders.all().any { it.uri == uri.toString() }) {
            Toast.makeText(this, "That folder is already added.", Toast.LENGTH_SHORT).show()
            return
        }
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or if (writable) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0
        try {
            contentResolver.takePersistableUriPermission(uri, flags)
        } catch (error: SecurityException) {
            Toast.makeText(this, "Android did not keep access to that folder.", Toast.LENGTH_LONG).show()
            return
        }
        val added = Graph.folders.add(SafFiles.displayName(this, uri), uri.toString(), writable)
        Graph.log.event("Added the folder ${added.name} (${if (writable) "read and change" else "read only"})")
        Graph.changes.fire()
    }

    // --- apps --------------------------------------------------------------------------------------------------------

    private fun appsSection() {
        content.addView(ui.heading("Apps the agent may use"))
        content.addView(ui.body("\"Look\" lets your agent read an app's screen, \"Act\" lets it touch too. These apply to the touch and type tools (the direct build only). A sensitive app asks you before every action, and your agent cannot act in it at all unless \"Destructive actions\" is on for this phone's card.", muted = true))
        for (request in Graph.requests.all()) {
            val verb = if (request.mode == AppMode.READ) "look at" else "act in"
            content.addView(ui.body("Your agent asks to $verb ${request.label}: ${request.reason.ifBlank { "no reason given" }}"))
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(ui.button("Allow") {
                Graph.requests.remove(request.pkg, request.mode)
                Graph.notifier.cancelAccess(request.pkg, request.mode)
                Graph.allowList.put(AllowedApp(request.pkg, Graph.apps.find(request.pkg)?.label ?: request.label, request.mode, sensitive = false))
                Graph.log.event("The owner allowed the agent to $verb ${request.label}")
                Graph.changes.fire()
            })
            row.addView(ui.button("Deny") {
                Graph.requests.remove(request.pkg, request.mode)
                Graph.requests.deny(request.pkg, request.mode)
                Graph.notifier.cancelAccess(request.pkg, request.mode)
                Graph.log.event("The owner said no to the agent asking to $verb ${request.label}")
                Graph.changes.fire()
            })
            content.addView(row)
        }
        val allowed = Graph.allowList.all()
        if (allowed.isEmpty() && Graph.requests.all().isEmpty()) {
            content.addView(ui.body("No apps yet."))
        }
        for (app in allowed) {
            content.addView(ui.body("${app.label} (${app.pkg})"))
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(ui.button(if (app.mode == AppMode.ACT) "Look and act" else "Look only") {
                val next = if (app.mode == AppMode.ACT) AppMode.READ else AppMode.ACT
                Graph.allowList.put(app.copy(mode = next))
                Graph.changes.fire()
            })
            row.addView(CheckBox(this).apply {
                text = "Sensitive"
                isChecked = app.sensitive
                setOnCheckedChangeListener { _, checked ->
                    Graph.allowList.put(app.copy(sensitive = checked))
                }
            })
            row.addView(ui.button("Remove") {
                Graph.allowList.remove(app.pkg)
                Graph.log.event("Removed ${app.label} from the apps the agent may use")
                Graph.changes.fire()
            })
            content.addView(row)
        }
        content.addView(ui.button("Add an app") { chooseApp() })
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
            .setNegativeButton("Cancel", null)
            .show()
    }

    // --- activity, unpair, about -------------------------------------------------------------------------------------

    private fun activitySection() {
        content.addView(ui.heading("Activity"))
        val recent = Graph.log.last(3)
        if (recent.isEmpty()) {
            content.addView(ui.body("Nothing yet."))
        }
        val format = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
        for (entry in recent) {
            content.addView(ui.body("${format.format(Date(entry.time))}  ${entry.tool ?: entry.text}${if (entry.tool != null) ": ${entry.text}" else ""}", muted = true))
        }
        content.addView(ui.button("See the last 100") { startActivity(Intent(this, ActivityLogActivity::class.java)) })
    }

    private fun confirmUnpair() {
        val host = Graph.pairings.get()?.sandboxUrl?.let { Graph.hostOf(it) } ?: return
        AlertDialog.Builder(this)
            .setTitle("Unpair from $host?")
            .setMessage("Your agent loses this phone, and the folders and apps you allowed are cleared. To remove the phone from your sandbox as well, delete its card there.")
            .setPositiveButton("Unpair") { _, _ -> Graph.unpair("The owner unpaired this phone") }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun aboutSection() {
        content.addView(ui.heading("About"))
        content.addView(ui.body("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}), ${BuildConfig.DISTRIBUTION} build."))
        content.addView(ui.body("Open source. It only does what you switch on here and on your sandbox's card, and it keeps the log above.", muted = true))
        val updates = Distribution.updates
        if (updates != null) {
            content.addView(ui.body("Updates: ${updates.status()}"))
            val label = updates.availableLabel()
            if (label != null) {
                content.addView(ui.button(label) { updates.install(this) })
            } else {
                content.addView(ui.button("Check for updates") { updates.check() })
            }
        } else {
            content.addView(ui.body("Updates come from the store.", muted = true))
        }
    }
}
