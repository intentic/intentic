import { execFile } from "node:child_process";
import { arch, homedir, hostname, platform, release, type } from "node:os";
import { promisify } from "node:util";
import type { HostFacts, HostScopes } from "@intentic/sandbox-contract";
import { rootsOf } from "../policy.js";
import { shellFor } from "./shell.js";

// What this device IS: without it an agent guesses (apt-get on Fedora, bash on Windows, paths outside its own
// boundary) and reports the refusal as a bug. Sent unprompted in the hello frame and on the sandbox's
// capability card.

const exec = promisify(execFile);

const osName = async (): Promise<string> => {
    if (platform() === "win32") {
        const { stdout } = await exec(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).Caption"],
            // The loop that calls this has no console (see tools/sandboxes.ts), so this asks for its own windowless one
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
const engineFacts = async (): Promise<HostFacts["engine"]> => {
    const { stdout } = await exec("docker", ["info", "--format", "{{.MemTotal}} {{.NCPU}}"], { timeout: 5_000, windowsHide: true }).catch(() => ({
        stdout: "",
    }));
    const [memoryBytes, cpus] = stdout.trim().split(/\s+/).map(Number);
    return memoryBytes !== undefined && cpus !== undefined && memoryBytes > 0 && cpus > 0 ? { memoryBytes, cpus } : undefined;
};

export const hostFacts = async (scopes: HostScopes): Promise<HostFacts> => {
    const [os, engine] = await Promise.all([osName(), engineFacts()]);
    return {
        os,
        arch: arch(),
        shell: shellFor(platform()).label,
        home: homedir(),
        roots: rootsOf(scopes),
        ...(engine === undefined ? {} : { engine }),
    };
};

// The agent-facing rendering. Includes the session type on Linux (Wayland vs X11 decides clipboard, screenshot
// and input idioms) and the machine's own name.
export const describeText = async (scopes: HostScopes): Promise<string> => {
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
            `Permissions: run commands ${scopes.shell}, write files ${scopes.write}, see the screen ${scopes.screen}, manage sandboxes ${scopes.sandboxes}`,
            // The ceiling a sandbox's share is held to, so a reshape is asked for in numbers this engine has.
            ...(facts.engine === undefined
                ? []
                : [`Docker engine: ${(facts.engine.memoryBytes / 1024 ** 3).toFixed(1)} GiB of memory, ${facts.engine.cpus} CPUs (what a sandbox's caps are bounded by)`]),
        ].join("\n") + session
    );
};
