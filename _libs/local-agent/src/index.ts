/* The plumbing every intentic CLI that lives on a USER'S OWN COMPUTER needs, and none of what any of them does.
 *
 * Three agents ship to a user's machine — `@intentic/host` (the sandbox's agent works on this computer),
 * `@intentic/sync` (files and ports mirrored between the two), `@intentic/acp-bridge` (an editor talks to the
 * sandbox) — and they have nothing in common except how they are INSTALLED and how they STAY alive: state under
 * `~/.intentic/<name>` with a credential in it, an autostart entry per OS, a way to re-invoke a compiled binary,
 * and a detached loop found again by pidfile.
 *
 * They were written months apart and each copy of that plumbing was made from the last one, which is a shape
 * with a known ending: the second copy is a snapshot of the first on the day it was taken, and every fix after
 * that lands in one of them. It already had. The sync agent wrote its token file world-readable because it was
 * copied before that floor existed; the host agent has no macOS entry because it was copied from a sync that did
 * not have one yet; and the Windows console lesson, the compiled-binary argv lesson and the "report what the
 * tool actually said" lesson are each written out at length in two files, in prose, cross-referencing the other
 * agent by name. This package is those lessons as code, so the fourth agent inherits them by importing. */

export { agentHome, writeSecretFile, type AgentHome, type Log } from "./home.js";
export { cliLauncher, quotedCommandLine, type CliLauncher } from "./launcher.js";
export {
    linuxDesktopEntry,
    macLaunchAgentXml,
    registerAutostart,
    unregisterAutostart,
    windowsRunAddArgs,
    windowsRunDeleteArgs,
    type AutostartSpec,
    type LaunchAgentSpec,
} from "./autostart.js";
export { detachedSpawnOptions, isProcessAlive, livePid, spawnDetached } from "./detached.js";
