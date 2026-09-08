import { spawnSync } from "node:child_process";
import { mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { type Log, WINDOWS_LAUNCH_STUB } from "@intentic/local-agent";
import { DEV_VERSION } from "@intentic/sandbox-contract";
import { agentPath } from "./installed.js";
import { readResidentBuild, readResidentPid, reconcileResidency, stopResident } from "./resident.js";
import { binDir } from "./sync/config.js";
import { archToken, download } from "./sync/mutagen.js";
import { assetUrl, realUpgradeExec, runUpgrade, type UpgradeExec, type UpgradeOutcome, upgradeMessage } from "./upgrade.js";
import { MACHINE_VERSION } from "./version.js";

// Everything an installer used to decide, decided here instead, once. device.{sh,ps1} and sync.{sh,ps1} are now
// bootstrap shims: they put a first agent on a machine that has none and exec `setup`; every other decision
// (version comparison, download, PATH, the Windows launcher) runs from this module on every setup. Self-update
// runs first in `prepareSetup` so the repairs below always run from the newest agent.

// Set on the re-exec after a self-update, so the updated agent doesn't ask GitHub the question that was just
// answered, and can never re-exec in a loop. Doubles as the escape hatch for a run that must not update.
export const SELF_UPDATE_GUARD_ENV = "INTENTIC_MACHINE_NO_SELF_UPDATE";

// How long to give a just-started loop to claim its pidfile before calling an upgrade a failure. Bounded by
// process startup, since the pidfile is its first act.
const RESIDENT_START_TIMEOUT_MS = 10_000;
const RESIDENT_START_POLL_MS = 200;

// Restart the loop and answer which build came up, the only answer that proves an upgrade landed. Waits for
// the pidfile rather than the build since the loop writes both together (resident.ts); undefined covers both
// "nothing started" and "started too slowly to say so".
const restartResident = async (): Promise<string | undefined> => {
    await reconcileResidency(() => undefined);
    await pollUntil(async () => (await readResidentPid()) !== undefined, { intervalMs: RESIDENT_START_POLL_MS, timeoutMs: RESIDENT_START_TIMEOUT_MS });
    return await readResidentBuild();
};

// The one wiring of the upgrade machinery to this machine's resident loop, shared by `upgrade` and the
// self-update below so the two cannot drift apart.
export const machineUpgradeExec = (out: Log): UpgradeExec => realUpgradeExec(stopResident, restartResident, readResidentBuild, out);

// Whether this process IS the installed agent, as opposed to a dev run or a binary somebody is trying from
// Downloads. Only the installed agent self-updates or edits the machine.
const runningAsInstalledAgent = async (): Promise<boolean> => {
    const from = await realpath(process.execPath).catch(() => undefined);
    const at = await realpath(agentPath).catch(() => undefined);
    return from !== undefined && from === at;
};

// The effects of the self-update, behind one seam, so the decision is testable without a network, a disk, or a
// process to replace.
export interface SelfUpdateIo {
    readonly installed: string;
    readonly installedAgent: () => Promise<boolean>;
    readonly upgrade: () => Promise<UpgradeOutcome>;
    readonly reexec: (args: readonly string[]) => never;
}

// Setup moves the machine onto the current agent before it enrolls anything. Cheap when current; on an actual
// update the new binary is swapped by the same machinery `upgrade` runs, and the new agent re-runs this very
// command, so setup always runs on the newest agent. A failed update is a note, never a refusal: the pairing
// token expires in minutes, and enrolling on a slightly older agent beats not enrolling.
export const selfUpdateBeforeSetup = async (
    io: SelfUpdateIo,
    env: Record<string, string | undefined>,
    args: readonly string[],
    out: Log,
): Promise<void> => {
    if (env[SELF_UPDATE_GUARD_ENV] !== undefined) {
        return;
    }
    if (io.installed === DEV_VERSION) {
        // A build made from source, deliberately, by whoever is running this: never replaced under them.
        return;
    }
    if (!(await io.installedAgent())) {
        return;
    }
    const outcome = await io.upgrade();
    if (outcome.kind === "upgraded") {
        out(upgradeMessage(outcome));
        io.reexec(args);
    }
    if (outcome.kind === "failed") {
        out(`note: couldn't update the agent first (${outcome.reason}) — continuing with ${io.installed}.`);
    }
};

export const realSelfUpdateIo = (out: Log): SelfUpdateIo => ({
    installed: MACHINE_VERSION,
    installedAgent: runningAsInstalledAgent,
    upgrade: async () => await runUpgrade(machineUpgradeExec(out), assetUrl, MACHINE_VERSION, false, out),
    reexec: (args) => {
        const child = spawnSync(agentPath, [...args], {
            stdio: "inherit",
            env: { ...process.env, [SELF_UPDATE_GUARD_ENV]: "1" },
            windowsHide: true,
        });
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

// The windowless launcher, kept fresh beside the agent: the difference between a quiet reconnect at every boot
// and a console window flashing on the desktop. The agent only registers the stub at logon if it finds it
// beside itself (@intentic/local-agent's autostart). Download-then-swap, since the stub may be running right now.
export const ensureWindowsLauncher = async (out: Log): Promise<void> => {
    if (process.platform !== "win32") {
        return;
    }
    const stub = join(binDir, WINDOWS_LAUNCH_STUB);
    const staged = `${stub}.tmp`;
    try {
        await rm(staged, { force: true });
        await download(`https://github.com/intentic/intentic/releases/latest/download/intentic-launch-windows-${archToken()}.exe`, staged);
        await rm(`${stub}.old`, { force: true }).catch(() => undefined);
        await rename(stub, `${stub}.old`).catch(() => undefined);
        await rename(staged, stub);
        await rm(`${stub}.old`, { force: true }).catch(() => undefined);
    } catch (error) {
        await rm(staged, { force: true }).catch(() => undefined);
        out(
            `note: couldn't download the windowless launcher (${errorMessage(error)}). Everything still works; a console window will flash on your desktop when this machine starts the agent at login.`,
        );
    }
};

// What every `setup` runs before it enrolls anything: move onto the current agent, then repair what the machine
// owes the user around the binary. The repairs run only when this process IS the installed agent.
export const prepareSetup = async (out: Log, args: readonly string[]): Promise<void> => {
    await selfUpdateBeforeSetup(realSelfUpdateIo(out), process.env, args, out);
    if (!(await runningAsInstalledAgent())) {
        return;
    }
    if (process.platform === "win32") {
        windowsPathRepair(out);
        await ensureWindowsLauncher(out);
        return;
    }
    await posixPathRepair(out);
};
