import { execFile } from "node:child_process";
import { arch, hostname, platform, release, type } from "node:os";
import { homeDir } from "@intentic/local-agent";
import { promisify } from "node:util";
import { DEVICE_FEATURE_LOOPBACK_CATCH, DEVICE_FEATURE_PROGRAMS, DEVICE_FEATURE_PROJECT_DELIVERY, type DeviceFacts, type DeviceScopes } from "@intentic/sandbox-contract";
import { type LinkReading, readLinkStates, unreachableIn } from "../config.js";
import { rootsOf, rootsText } from "../policy.js";
import { shellFor } from "./shell.js";
import { listDistros, WINDOWS_SIDE, wslEnvironment } from "../../environments/wsl.js";
import { machineId } from "../../machine-id.js";
import { deviceFeatures, icOutOfDate, icOverrides, type InstalledIc, installedIc } from "./ic-binary.js";
import { previousExit, thisRun } from "../../resident/last-exit.js";
import { MACHINE_VERSION } from "../../version.js";
import { readUpkeepSummary } from "../../upkeep/reconcile.js";

// What this device IS: without it an agent guesses (apt-get on Fedora, bash on Windows, paths outside its own
// boundary) and reports the refusal as a bug. Sent unprompted in the hello frame and on the sandbox's
// capability card.

const exec = promisify(execFile);

const osName = async (): Promise<string> => {
    if (platform() === "win32") {
        const { stdout } = await exec(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).Caption"],
            // The agent that calls this has no console (see tools/sandboxes.ts), so this asks for its own windowless one
            // rather than being given a visible console by Windows.
            { windowsHide: true },
        ).catch(() => ({ stdout: "" }));
        const caption = stdout.trim();
        return caption === "" ? `Windows (${release()})` : `${caption} (build ${release()})`;
    }
    // /etc/os-release is the one file every modern distribution has, and PRETTY_NAME is the line humans use.
    const { stdout } = await exec("sh", ["-c", '. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME"']).catch(() => ({ stdout: "" }));
    const pretty = stdout.trim();
    return pretty === "" ? `${type()} ${release()}` : `${pretty} (kernel ${release()})`;
};

// How big the Docker engine is, the ceiling every sandbox is bounded by (the WSL guest, the Desktop VM, or the
// host). Read via `docker info` since on two of the three platforms that's a different computer from this
// one's own /proc. Bounded by a short timeout; absent, never guessed.
const engineFacts = async (): Promise<DeviceFacts["engine"]> => {
    const { stdout } = await exec("docker", ["info", "--format", "{{.MemTotal}} {{.NCPU}}"], { timeout: 5_000, windowsHide: true }).catch(() => ({
        stdout: "",
    }));
    const [memoryBytes, cpus] = stdout.trim().split(/\s+/).map(Number);
    return memoryBytes !== undefined && cpus !== undefined && memoryBytes > 0 && cpus > 0 ? { memoryBytes, cpus } : undefined;
};

// Windows only: the distros `run_command`'s `in: "wsl:<name>"` can reach; absent, never guessed, where the listing fails.
const wslDistros = async (): Promise<string[] | undefined> => {
    const distros = WINDOWS_SIDE ? await listDistros() : undefined;
    return distros === undefined || distros.length === 0 ? undefined : distros;
};

// This machine's links as a count, from the stamp the resident agent keeps (device/config.ts) rather than from the
// sockets, since `describe` is answered on one of them and knows only its own. Which links count as unreachable is
// `unreachableIn`'s to say, so this and the drop that acts on it can never disagree about what is gone.
// Takes the reading rather than fetching it: the decision is what is worth pinning, and a pure one is pinnable without
// a filesystem. No stamp at all answers undefined rather than zero — an agent that has not stamped is not a tidy one.
export const linkFacts = (stamped: Readonly<Record<string, LinkReading>> | undefined): DeviceFacts["links"] => {
    if (stamped === undefined) {
        return undefined;
    }
    const gone = unreachableIn(stamped);
    const since = gone.map(({ outage }) => outage.since);
    return {
        total: Object.keys(stamped).length,
        unreachable: gone.length,
        ...(since.length === 0 ? {} : { unreachableSince: Math.min(...since) }),
    };
};

export const hostFacts = async (scopes: DeviceScopes): Promise<DeviceFacts> => {
    const [os, engine, wsl, distros, stamped, features, upkeep, ic] = await Promise.all([
        osName(),
        engineFacts(),
        wslEnvironment(),
        wslDistros(),
        readLinkStates(),
        deviceFeatures(),
        readUpkeepSummary(),
        installedIc(),
    ]);
    const links = linkFacts(stamped);
    // Read after deviceFeatures, which fetched (or failed to fetch) the current ic first.
    const stale = icOutOfDate();
    const facts: DeviceFacts = {
        machineId: machineId(),
        os,
        arch: arch(),
        shell: shellFor(platform()).label,
        home: homeDir(),
        roots: rootsOf(scopes),
        hostname: hostname(),
        ...(engine === undefined ? {} : { engine }),
        ...(wsl === undefined ? {} : { wsl }),
        ...(distros === undefined ? {} : { wslDistros: distros }),
        ...(links === undefined ? {} : { links }),
        // What this agent and the ic under it implement: the ic's asked of that ic rather than written down here, and
        // the agent's own (the loopback catch, landed work delivered into an attached folder) always, since this build
        // answers both.
        features: [...features, DEVICE_FEATURE_LOOPBACK_CATCH, DEVICE_FEATURE_PROJECT_DELIVERY, DEVICE_FEATURE_PROGRAMS],
    };
    // Why that list is short, when the ic under it could not be brought up to date.
    if (stale !== undefined) {
        facts.icOutOfDate = stale;
    }
    // What the last upkeep pass here found, put right and left (upkeep/reconcile.ts): counts and the first lines only.
    if (upkeep !== undefined) {
        facts.upkeep = upkeep;
    }
    // The same lines describe prints (agentLines), on the card the sandbox caches, so a reconnect says why it dropped.
    const previous = previousExit();
    if (previous !== undefined) {
        facts.previousExit = previous;
    }
    if (ic !== undefined) {
        facts.ic = { path: ic.path, version: ic.version, ...(ic.modified === undefined ? {} : { modified: ic.modified }) };
    }
    const overrides = icOverrides(process.env);
    if (overrides.length > 0) {
        facts.icOverrides = overrides;
    }
    return facts;
};

// The other environments of this same computer, and how a command crosses into them: the one fact about a Windows
// PC an agent cannot see from the tool list.
const environmentLines = (facts: DeviceFacts): string[] => {
    if (facts.wsl !== undefined) {
        return [
            `Environment: the WSL distro "${facts.wsl.distro}" on the Windows PC ${facts.hostname ?? hostname()}. The screen, the GUI and the clipboard are the Windows side's; run_command with in: "windows" runs PowerShell there (a Windows path as cwd, e.g. C:\\Users\\you). Windows drives are under /mnt here (C:\\ is /mnt/c).`,
        ];
    }
    if (facts.wslDistros !== undefined) {
        return [
            `WSL distros on this PC: ${facts.wslDistros.join(", ")}. run_command with in: "wsl:<name>" runs a command inside one through sh -lc, with no PowerShell quoting in the way; a distro's files are under \\\\wsl.localhost\\<name>\\ from here, and this PC's drives are under /mnt there. One Docker engine serves this PC and every distro on it.`,
        ];
    }
    return [];
};

// Which ic answers here and what steers it, and this agent's own run: the lines an agent otherwise hunts for with
// run_command (where is ic.exe, which version, is an IC_URL left over, why did the agent restart). Pure.
export const agentLines = (
    ic: InstalledIc | undefined,
    overrides: readonly string[],
    run: { readonly version: string; readonly startedAt?: string | undefined; readonly previous?: string | undefined },
): string[] => [
    `Agent: intentic-machine ${run.version}${run.startedAt === undefined ? "" : `, running since ${run.startedAt}`}; its own logs are read with device_logs`,
    ...(run.previous === undefined ? [] : [`Before it: ${run.previous}`]),
    ic === undefined
        ? "ic: none answers here (looked in ~/.intentic/ic/bin, /usr/local/bin and PATH)"
        : `ic: ${ic.version} at ${ic.path}${ic.modified === undefined ? "" : ` (written ${ic.modified})`}`,
    ...(overrides.length === 0 ? [] : [`Overrides in the agent's environment: ${overrides.join(", ")}`]),
];

// The agent-facing rendering. Includes the session type on Linux (Wayland vs X11 decides clipboard, screenshot
// and input idioms) and the machine's own name.
export const describeText = async (scopes: DeviceScopes): Promise<string> => {
    const [facts, ic] = await Promise.all([hostFacts(scopes), installedIc()]);
    const session = platform() === "linux" ? `\nGraphical session: ${process.env["XDG_SESSION_TYPE"] ?? "none detected (headless)"}` : "";
    return (
        [
            `Device: ${hostname()}`,
            `OS: ${facts.os}`,
            `Architecture: ${facts.arch}`,
            `Shell for run_command: ${facts.shell}`,
            `Home: ${facts.home}`,
            `Folders you may read and write: ${rootsText(facts.roots)}`,
            ...environmentLines(facts),
            `Permissions: run commands ${scopes.shell}, run destructive commands ${scopes.destructive}, write files ${scopes.write}, see the screen ${scopes.screen}, use the mouse and keyboard ${scopes.control}, manage sandboxes ${scopes.sandboxes}, run programs this sandbox sends ${scopes.programs}`,
            ...agentLines(ic, icOverrides(process.env), { version: MACHINE_VERSION, startedAt: thisRun()?.startedAt, previous: previousExit() }),
            ...(facts.icOutOfDate === undefined ? [] : [facts.icOutOfDate]),
            // All a sandbox can use, so a reshape is asked for in numbers this engine has.
            ...(facts.engine === undefined
                ? []
                : [
                      `Docker engine: ${(facts.engine.memoryBytes / 1024 ** 3).toFixed(1)} GiB of memory, ${facts.engine.cpus} CPUs (all a sandbox can use: a CPU cap stops at the cores, and a memory cap past the memory is no cap)`,
                  ]),
        ].join("\n") + session
    );
};
