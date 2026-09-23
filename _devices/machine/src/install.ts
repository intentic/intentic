import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { DEV_VERSION } from "@intentic/sandbox-contract";
import { binDir } from "./config.js";
import { adoptRunningDistros } from "./environments/commands.js";
import { launchUpgrade, UPGRADE_ENV, upgradeHereToMachine } from "./environments/machine-upgrade.js";
import { runningAsInstalledAgent } from "./installed.js";
import { agentPath, download, launcherAssetUrl, launcherPath } from "./release.js";
import { type UpgradeOutcome, upgradeMessage } from "./upgrade.js";
import { MACHINE_VERSION } from "./version.js";

// Everything an installer used to decide, decided once, here: the shims put a first agent down and exec `setup`.

// The effects of the self-update, behind one seam, so the decision is testable without a network, a disk, or a
// process to replace.
export interface SelfUpdateIo {
    readonly installed: string;
    readonly installedAgent: () => boolean;
    readonly upgrade: () => Promise<UpgradeOutcome>;
    readonly reexec: (args: readonly string[], version: string) => never;
}

// Setup runs on the machine's newest agent: this environment first, the rest of the PC right after (completeSetup).
// A failed update is a note, never a refusal: the pairing token expires in minutes.
export const selfUpdateBeforeSetup = async (
    io: SelfUpdateIo,
    env: Record<string, string | undefined>,
    args: readonly string[],
    out: Log,
): Promise<void> => {
    if (env[UPGRADE_ENV] !== undefined || io.installed === DEV_VERSION || !io.installedAgent()) {
        return;
    }
    const outcome = await io.upgrade();
    if (outcome.kind === "upgraded") {
        out(upgradeMessage(outcome));
        io.reexec(args, outcome.to);
    }
    if (outcome.kind === "failed") {
        out(`note: couldn't update the agent first (${outcome.reason}) — continuing with ${io.installed}.`);
    }
};

export const realSelfUpdateIo = (out: Log): SelfUpdateIo => ({
    installed: MACHINE_VERSION,
    installedAgent: runningAsInstalledAgent,
    upgrade: async () => await upgradeHereToMachine(out),
    reexec: (args, version) => {
        const child = spawnSync(agentPath, [...args], { stdio: "inherit", env: { ...process.env, [UPGRADE_ENV]: version }, windowsHide: true });
        process.exit(child.status ?? 1);
    },
});

// `intentic-machine` on the user's PATH, repaired on every setup, so the commands the setup output names are
// real rather than a promise the installer couldn't keep. POSIX gets a symlink into ~/.local/bin; Windows gets
// the bin dir appended to the per-user PATH.
const posixPathRepair = async (out: Log): Promise<void> => {
    const linkDir = join(homedir(), ".local", "bin");
    const link = join(linkDir, "intentic-machine");
    try {
        await mkdir(linkDir, { recursive: true });
        await rm(link, { force: true });
        await symlink(agentPath, link);
    } catch (error) {
        out(`note: couldn't link ${link} (${errorMessage(error)}) — run ${agentPath} directly.`);
        return;
    }
    if (!(process.env["PATH"] ?? "").split(":").includes(linkDir)) {
        out(`note: add ~/.local/bin to your PATH to use \`intentic-machine\` directly (or run ${agentPath}).`);
    }
};

// The per-user PATH with `folder` appended, or undefined when already there. The value must go back under the
// kind it already had: a REG_EXPAND_SZ written back as REG_SZ stops every %VAR%-style entry from expanding.
// Membership is case-insensitive, as PowerShell's -contains compares.
export const addToWindowsPathValue = (stored: string, folder: string): string | undefined => {
    const entries = stored.split(";").filter((entry) => entry !== "");
    if (entries.some((entry) => entry.toLowerCase() === folder.toLowerCase())) {
        return undefined;
    }
    return [...entries, folder].join(";");
};

// Explorer hands every terminal it starts a copy of the environment taken at its own startup; without this
// broadcast the new PATH reaches nothing until the next sign-in. SendMessageTimeout, so one wedged window
// cannot wedge a setup.
const WINDOWS_ENV_BROADCAST = [
    `$s='[DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern IntPtr SendMessageTimeout(IntPtr w,uint m,UIntPtr wp,string lp,uint f,uint t,out UIntPtr r);'`,
    `Add-Type -Namespace Intentic -Name Native -MemberDefinition $s`,
    `$r=[UIntPtr]::Zero`,
    `[void][Intentic.Native]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)`,
].join(";");

// HKCU\Environment is read and written through reg.exe, which neither expands REG_EXPAND_SZ on query nor
// changes a value's kind on add, the property [Environment]::SetEnvironmentVariable lacks.
const readWindowsPath = (): { readonly kind: string; readonly stored: string } => {
    const query = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    const match = query.status === 0 ? /^\s*Path\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/m.exec(query.stdout) : null;
    return { kind: match?.[1] ?? "REG_EXPAND_SZ", stored: match?.[2]?.trimEnd() ?? "" };
};

const writeWindowsPath = (kind: string, value: string): void => {
    const add = spawnSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", kind, "/d", value, "/f"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
    });
    if (add.status !== 0) {
        throw new Error(add.stderr.trim() === "" ? `reg add exited ${String(add.status)}` : add.stderr.trim());
    }
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENV_BROADCAST], { windowsHide: true, timeout: 15_000 });
};

const windowsPathRepair = (out: Log): void => {
    try {
        const { kind, stored } = readWindowsPath();
        const next = addToWindowsPathValue(stored, binDir);
        if (next === undefined) {
            return;
        }
        writeWindowsPath(kind, next);
        out(`note: ${binDir} was added to your PATH — open a new terminal to use \`intentic-machine\` directly.`);
    } catch (error) {
        // Best-effort: PATH is the convenience, connecting is the job.
        out(
            `note: couldn't put ${binDir} on your PATH (${errorMessage(error)}). Run intentic-machine from that folder, or add it to your PATH yourself.`,
        );
    }
};

// The windowless launcher where there is none yet, pinned to this agent's release; an upgrade replaces it with the agent.
const ensureWindowsLauncher = async (out: Log): Promise<void> => {
    if (process.platform !== "win32" || MACHINE_VERSION === DEV_VERSION || existsSync(launcherPath)) {
        return;
    }
    const staged = `${launcherPath}.tmp`;
    try {
        await rm(staged, { force: true });
        await download(launcherAssetUrl(MACHINE_VERSION), staged);
        await rename(staged, launcherPath);
    } catch (error) {
        await rm(staged, { force: true }).catch(() => undefined);
        out(
            `note: couldn't download the windowless launcher (${errorMessage(error)}). Everything still works; a console window will flash on your desktop when this machine starts the agent at login.`,
        );
    }
};

// What every `setup` runs before it enrolls anything: move onto the machine's newest agent, then repair what the
// machine owes the user around the binary. The repairs run only when this process IS the installed agent.
export const prepareSetup = async (out: Log, args: readonly string[]): Promise<void> => {
    await selfUpdateBeforeSetup(realSelfUpdateIo(out), process.env, args, out);
    if (!runningAsInstalledAgent()) {
        return;
    }
    if (process.platform === "win32") {
        windowsPathRepair(out);
        await ensureWindowsLauncher(out);
        return;
    }
    await posixPathRepair(out);
};

// What every `setup` runs once it has enrolled: the Windows side takes over distros already running an agent, and a
// setup that moved this side onto a newer release brings the rest of the PC level with it, in the background.
export const completeSetup = async (out: Log): Promise<void> => {
    await adoptRunningDistros(out);
    if (process.env[UPGRADE_ENV] === undefined) {
        return;
    }
    delete process.env[UPGRADE_ENV];
    await launchUpgrade(true).catch((error: unknown) =>
        out(`note: couldn't bring the rest of this PC to this release (${errorMessage(error)}); it catches up within the hour.`),
    );
};
