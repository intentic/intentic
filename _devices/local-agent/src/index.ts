// Shared plumbing for intentic CLIs that run on a user's own device: state under `~/.intentic/<name>`, autostart per
// OS, re-invoking a compiled binary, and a detached loop found again by pidfile. Used by @intentic/machine and
// @intentic/acp-bridge.

export { agentHome, writeSecretFile, type AgentHome, type Log } from "./home.js";
export { cliLauncher, quotedCommandLine, stubCommand, WINDOWS_LAUNCH_STUB, windowsLaunchStub, type CliLauncher } from "./launcher.js";
export {
    clearWindowsRunValue,
    linuxDesktopEntry,
    macLaunchAgentXml,
    registerAutostart,
    setWindowsRunValue,
    unregisterAutostart,
    windowsRunAddArgs,
    windowsRunDeleteArgs,
    type AutostartSpec,
    type LaunchAgentSpec,
} from "./autostart.js";
export { isProcessAlive, livePid, livePidRecord, type PidRecord, pidFileBody, spawnDetached } from "./detached.js";
export { agentException } from "./text.js";
export {
    asLabel,
    createUi,
    estimate,
    humanDuration,
    truncate,
    wrap,
    type Footnote,
    type PlanStep,
    type RowOutcome,
    type Ui,
    type UiMode,
    type UiProcess,
} from "./ui.js";
