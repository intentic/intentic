package dev.intentic.device.touch

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import dev.intentic.device.BuildConfig
import dev.intentic.device.Graph
import dev.intentic.device.policy.Switch
import dev.intentic.device.tools.Tool
import dev.intentic.device.tools.ToolDeps

/** The touch tools wired to the phone: the service, the person's allow-list and switches, and the notifications that ask them. */
object TouchRuntime {
    /** What asks the person, and takes their tap. Created with the app's parts, so it uses them when asked, not before. */
    val confirmations: Confirmations by lazy {
        Confirmations(
            sink = object : PromptSink {
                override fun show(id: Int, title: String, text: String) {
                    val context = Graph.appContext()
                    Graph.notifier.prompt(id, title, text, answer(context, ConfirmReceiver.ACTION_ALLOW, id), answer(context, ConfirmReceiver.ACTION_DENY, id), Confirmations.TIMEOUT_MS)
                }

                override fun dismiss(id: Int) = Graph.notifier.cancel(id)
            },
            paused = { Graph.settings.paused },
        )
    }

    private fun answer(context: Context, action: String, id: Int): Intent =
        Intent(context, ConfirmReceiver::class.java).setAction(action).putExtra(ConfirmReceiver.EXTRA_ID, id)

    fun tools(deps: ToolDeps): List<Tool> {
        val policy = AppPolicy(
            ownPackage = BuildConfig.APPLICATION_ID,
            launchers = ::launcherPackages,
            allowed = deps.allowList::find,
            destructiveOn = { deps.scopes()?.allows(Switch.DESTRUCTIVE) == true },
        )
        val env = TouchEnv(AndroidTouch, deps.scopes, policy, confirmations, deps.frames, deps.screen)
        return listOf(UiElementsTool(env), UiActTool(env), DeviceTool(env))
    }

    /** The home screens installed, looked up when needed: the person can change their launcher. */
    private fun launcherPackages(): Set<String> {
        val packages = TouchService.instance?.packageManager ?: return emptySet()
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val found = if (android.os.Build.VERSION.SDK_INT >= 33) {
            packages.queryIntentActivities(home, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            packages.queryIntentActivities(home, 0)
        }
        return found.map { it.activityInfo.packageName }.toSet()
    }
}
