// Shared plumbing for intentic CLIs that run on a user's own device: state under `~/.intentic/<name>`, autostart per
// OS, re-invoking a compiled binary, and a detached agent found again by pidfile. Used by @intentic/machine and
// @intentic/acp-bridge.

export { agentHome, homeDir, writeSecretFile, type AgentHome, type Log } from "./home.js";
export { cliLauncher, quotedCommandLine, stubCommand, WINDOWS_LAUNCH_STUB, windowsLaunchStub, type CliLauncher } from "./launcher.js";
export {
    autostart,
    clearWindowsRunValue,
    linuxDesktopEntry,
    macLaunchAgentXml,
    ROTATE_LOG_SH,
    setWindowsRunValue,
    supervisedPath,
    windowsRunAddArgs,
    windowsRunDeleteArgs,
    type Autostart,
    type AutostartKind,
    type AutostartSpec,
    type LaunchAgentSpec,
} from "./autostart.js";
export {
    claimPidFile,
    holdPidFile,
    isProcessAlive,
    livePid,
    livePidRecord,
    LOG_ROTATE_BYTES,
    type PidClaim,
    type PidRecord,
    pidFileBody,
    releasePidFile,
    spawnDetached,
    stopProcess,
} from "./detached.js";
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
