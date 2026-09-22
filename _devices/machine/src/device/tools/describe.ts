import { execFile } from "node:child_process";
import { arch, homedir, hostname, platform, release, type } from "node:os";
import { promisify } from "node:util";
import type { DeviceFacts, DeviceScopes } from "@intentic/sandbox-contract";
import { type LinkReading, readLinkStates, unreachableIn } from "../config.js";
import { rootsOf } from "../policy.js";
import { shellFor } from "./shell.js";
import { wslEnvironment } from "../../wsl.js";

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

// The distros `wsl -l -q` lists, one per line. Older wsl.exe builds print UTF-16 whatever the console is set to, which
// arrives through a UTF-8 decode as every other byte NUL; stripping them is what turns that back into names.
export const distrosFrom = (stdout: string): string[] =>
    stdout
        .replaceAll("\0", "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");

// Windows only: which distros `run_command`'s `in: "wsl:<name>"` can reach. Absent, never guessed, where WSL is not
// installed or the listing fails; `WSL_UTF8` asks wsl.exe for UTF-8 where it knows how.
const wslDistros = async (): Promise<string[] | undefined> => {
    if (platform() !== "win32") {
        return undefined;
    }
    const { stdout } = await exec("wsl.exe", ["-l", "-q"], { timeout: 5_000, windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } }).catch(
        () => ({ stdout: "" }),
    );
    const distros = distrosFrom(stdout);
    return distros.length === 0 ? undefined : distros;
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
    const [os, engine, wsl, distros, stamped] = await Promise.all([osName(), engineFacts(), wslEnvironment(), wslDistros(), readLinkStates()]);
    const links = linkFacts(stamped);
    return {
        os,
        arch: arch(),
        shell: shellFor(platform()).label,
        home: homedir(),
        roots: rootsOf(scopes),
        hostname: hostname(),
        ...(engine === undefined ? {} : { engine }),
        ...(wsl === undefined ? {} : { wsl }),
        ...(distros === undefined ? {} : { wslDistros: distros }),
        ...(links === undefined ? {} : { links }),
    };
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

// The agent-facing rendering. Includes the session type on Linux (Wayland vs X11 decides clipboard, screenshot
// and input idioms) and the machine's own name.
export const describeText = async (scopes: DeviceScopes): Promise<string> => {
    const facts = await hostFacts(scopes);
    const session = platform() === "linux" ? `\nGraphical session: ${process.env["XDG_SESSION_TYPE"] ?? "none detected (headless)"}` : "";
    return (
        [
            `Device: ${hostname()}`,
            `OS: ${facts.os}`,
            `Architecture: ${facts.arch}`,
            `Shell for run_command: ${facts.shell}`,
            `Home: ${facts.home}`,
            `Folders you may read and write: ${facts.roots.join(", ")}`,
            ...environmentLines(facts),
            `Permissions: run commands ${scopes.shell}, write files ${scopes.write}, see the screen ${scopes.screen}, manage sandboxes ${scopes.sandboxes}`,
            // All a sandbox can use, so a reshape is asked for in numbers this engine has.
            ...(facts.engine === undefined
                ? []
                : [
                      `Docker engine: ${(facts.engine.memoryBytes / 1024 ** 3).toFixed(1)} GiB of memory, ${facts.engine.cpus} CPUs (all a sandbox can use: a CPU cap stops at the cores, and a memory cap past the memory is no cap)`,
                  ]),
        ].join("\n") + session
    );
};
