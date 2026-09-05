import { execFile } from "node:child_process";
import { arch, homedir, hostname, platform, release, type } from "node:os";
import { promisify } from "node:util";
import type { HostFacts, HostScopes } from "@intentic/sandbox-contract";
import { rootsOf } from "../policy.js";
import { shellFor } from "./shell.js";

/* What this device IS, the single highest-leverage thing for the quality of the agent's work here.
 *
 * An agent without this guesses: it writes `apt-get` on Fedora, assumes bash on Windows, invents a home
 * directory, and reaches for paths outside its own boundary and then reports the refusal as a bug. One call
 * removes all of that, which is why it is also sent unprompted in the hello frame, the sandbox's capability
 * card shows it, so the machine is legible before the agent asks anything.
 *
 * The OS name is read from the OS itself rather than from node's `release()`, which on Windows says "10.0.26100"
 * (a build number nobody can act on) and on Linux says the kernel version rather than the distribution, and the
 * distribution is what decides the package manager. */

const exec = promisify(execFile);

const osName = async (): Promise<string> => {
    if (platform() === "win32") {
        const { stdout } = await exec(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).Caption"],
            // The loop that calls this has no console (tools/sandboxes.ts says why), so this asks for its own
            // windowless one rather than being given a visible console by Windows.
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

export const hostFacts = async (scopes: HostScopes): Promise<HostFacts> => ({
    os: await osName(),
    arch: arch(),
    shell: shellFor(platform()).label,
    home: homedir(),
    roots: rootsOf(scopes),
});

// The agent-facing rendering. Includes the session type on Linux (Wayland vs X11 decides every clipboard,
// screenshot and input idiom) and the machine's own name, which is how the user refers to it out loud.
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
        ].join("\n") + session
    );
};
