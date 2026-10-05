package dev.intentic.device.tools

import dev.intentic.device.policy.Scopes
import dev.intentic.device.store.AppAllowList
import dev.intentic.device.store.FolderStore
import org.json.JSONObject

/** Everything the tools take from the phone. */
class ToolDeps(
    val facts: () -> JSONObject,
    val scopes: () -> Scopes?,
    val screen: ScreenPort,
    val frames: FrameLog,
    val apps: AppsPort,
    val allowList: AppAllowList,
    val folders: FolderStore,
    val files: FilesPort,
    val clipboard: ClipboardPort,
    val notices: NoticesPort,
)

object Registry {
    /**
     * Every tool both builds answer, in the order `tools/list` shows them. [extra] is what the build flavor adds on top:
     * the `direct` build's touch tools (ui_elements, ui_act, device), which need the accessibility service. The `play`
     * build adds none.
     */
    fun tools(deps: ToolDeps, extra: List<Tool> = emptyList()): List<Tool> =
        listOf(
            DescribeTool(deps.facts, deps.scopes),
            ScreenshotTool(deps.screen, deps.frames),
            OpenTool(deps.apps),
            AppsTool(deps.apps, deps.allowList),
            AskAccessTool(deps.apps, deps.allowList),
            ListDirTool(deps.folders, deps.files),
            ReadFileTool(deps.folders, deps.files),
            WriteFileTool(deps.folders, deps.files),
            TrashFileTool(deps.folders, deps.files),
            ClipboardTool(deps.clipboard),
            NotificationsTool(deps.notices),
        ) + extra
}
