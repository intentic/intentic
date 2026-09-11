import { readFile } from "node:fs/promises";

// Whether this agent is running inside a WSL distro rather than on the machine itself, and which distro. WSL hands a
// distro the Windows computer's name, so `hostname` alone makes Windows and every distro on it look like one machine
// with one agent. Everything that joins two readings into a row needs this to tell them apart.

// The line WSL writes into its kernel version string, on both WSL1 ("Microsoft") and WSL2
// ("microsoft-standard-WSL2"). Matched case-insensitively so one test covers both.
const WSL_KERNEL = /microsoft/i;

// Pure over what was read, so the rules are testable without a filesystem. `WSL_DISTRO_NAME` alone is enough: WSL sets
// it and nothing else does, which also covers a distro whose /proc was not readable.
export const wslFrom = (
    procVersion: string | undefined,
    distroEnv: string | undefined,
    osRelease: string | undefined,
): { readonly distro: string } | undefined => {
    const named = (distroEnv ?? "").trim();
    if (named === "" && !WSL_KERNEL.test(procVersion ?? "")) {
        return undefined;
    }
    // WSL's own name for the distro is the one the owner sees in `wsl -l`, so it wins over what the distro calls
    // itself. An unreadable name is carried as empty rather than guessed: presence is the fact that matters.
    return { distro: named === "" ? nameFrom(osRelease) : named };
};

// `NAME="Arch Linux"` out of /etc/os-release, quotes stripped. Empty for anything that doesn't have the line.
const nameFrom = (osRelease: string | undefined): string => {
    const line = (osRelease ?? "").split(/\r?\n/).find((entry) => entry.startsWith("NAME="));
    return line === undefined ? "" : line.slice("NAME=".length).trim().replaceAll(/^"|"$/g, "");
};

const readable = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

// One reading per report. Costs two small reads on Linux and nothing anywhere else, since neither path exists there.
export const wslEnvironment = async (): Promise<{ readonly distro: string } | undefined> => {
    const [procVersion, osRelease] = await Promise.all([readable("/proc/version"), readable("/etc/os-release")]);
    return wslFrom(procVersion, process.env["WSL_DISTRO_NAME"], osRelease);
};
