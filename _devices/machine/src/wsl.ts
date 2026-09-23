import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { WSL_SYSTEM_DISTROS } from "@intentic/sandbox-contract";

// Whether this agent is running inside a WSL distro rather than on the machine itself, and which distro. WSL hands a
// distro the Windows computer's name, so `hostname` alone makes Windows and every distro on it look like one machine
// with one agent. Everything that joins two readings into a row needs this to tell them apart.
//
// THE NAME HAS TO BE WSL'S REGISTRATION NAME, not a pretty one. It is what `wsl -l -q` prints, what
// `run_command`'s `in: "wsl:<name>"` accepts, and what the sandbox matches a listed distro against — so a distro
// answering "Arch Linux" where the listing says "archlinux" reads as a distro that is not connected while it is
// sitting right there, connected.

// The line WSL writes into its kernel version string, on both WSL1 ("Microsoft") and WSL2
// ("microsoft-standard-WSL2"). Matched case-insensitively so one test covers both.
const WSL_KERNEL = /microsoft/i;

const exec = promisify(execFile);

// `wslpath -w /` answers `\\wsl.localhost\archlinux\` (`\\wsl$\archlinux\` on older builds): the second component is
// the registration name. Anything else — interop off, no wslpath, a drive path — names nothing.
const registeredFrom = (wslRoot: string | undefined): string => /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/.exec((wslRoot ?? "").trim())?.[1] ?? "";

// The registration name alone, from the two sources that carry it; what `wsl.exe -d` needs, so never a pretty one.
export const registeredNameFrom = (distroEnv: string | undefined, wslRoot: string | undefined): string | undefined =>
    [registeredFrom(wslRoot), (distroEnv ?? "").trim()].find((name) => name !== "");

// Pure over what was read, so the rules are testable without a filesystem. Three sources, best first: the
// registration name WSL itself reports through `wslpath`, then `WSL_DISTRO_NAME`, which is the same string but only
// where the launcher's environment survived, then what the distro calls itself — a last resort that is NOT the
// registration name and is kept only because presence is the fact that matters.
export const wslFrom = (
    procVersion: string | undefined,
    distroEnv: string | undefined,
    osRelease: string | undefined,
    wslRoot?: string | undefined,
): { readonly distro: string } | undefined => {
    const named = registeredNameFrom(distroEnv, wslRoot) ?? "";
    if (named === "" && !WSL_KERNEL.test(procVersion ?? "")) {
        return undefined;
    }
    return { distro: named === "" ? nameFrom(osRelease) : named };
};

// `NAME="Arch Linux"` out of /etc/os-release, quotes stripped. Empty for anything that doesn't have the line.
const nameFrom = (osRelease: string | undefined): string => {
    const line = (osRelease ?? "").split(/\r?\n/).find((entry) => entry.startsWith("NAME="));
    return line === undefined ? "" : line.slice("NAME=".length).trim().replaceAll(/^"|"$/g, "");
};

const readable = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

// Asking WSL what it calls this distro. Short deadline and every failure swallowed: interop can be off, wslpath can
// be absent, and neither is a reason for a report to fail — the fallbacks below answer instead.
const WSLPATH_TIMEOUT_MS = 2_000;
const wslRoot = async (): Promise<string | undefined> =>
    (await exec("wslpath", ["-w", "/"], { timeout: WSLPATH_TIMEOUT_MS }).catch(() => undefined))?.stdout;

// One reading per report. Two small reads on Linux, nothing anywhere else since neither path exists there, and the
// one spawn only where the kernel has already said WSL — a native Linux box never pays for it.
export const wslEnvironment = async (): Promise<{ readonly distro: string } | undefined> => {
    const [procVersion, osRelease] = await Promise.all([readable("/proc/version"), readable("/etc/os-release")]);
    const root = WSL_KERNEL.test(procVersion ?? "") ? await wslRoot() : undefined;
    return wslFrom(procVersion, process.env["WSL_DISTRO_NAME"], osRelease, root);
};

// This distro's registration name, or undefined outside WSL or where WSL will not say it: a guess would be refused by wsl.exe.
export const registeredDistro = async (): Promise<string | undefined> => {
    if (!WSL_KERNEL.test((await readable("/proc/version")) ?? "")) {
        return undefined;
    }
    return registeredNameFrom(process.env["WSL_DISTRO_NAME"], await wslRoot());
};

// The user's distros `wsl -l -q` lists, one per line; older wsl.exe prints UTF-16 regardless, which decodes with every other byte NUL.
export const distrosFrom = (stdout: string): string[] =>
    stdout
        .replaceAll("\0", "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !WSL_SYSTEM_DISTROS.has(line));

// The user's own distros as this side of the PC sees them (Windows, or a distro through interop); undefined when WSL
// cannot be asked, so a failed listing is never read as "there are none".
export const listDistros = async ({ running = false }: { readonly running?: boolean } = {}): Promise<string[] | undefined> => {
    const answer = await exec("wsl.exe", ["-l", "-q", ...(running ? ["--running"] : [])], {
        timeout: 5_000,
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: "1" },
    }).catch(() => undefined);
    return answer === undefined ? undefined : distrosFrom(answer.stdout);
};

// Which environment of a PC this agent is: its Windows side, one of its WSL distros, or a computer with no other side.
export type Side = "windows" | "wsl" | "native";

// Only the Windows side of a PC holds distros, and knowing it needs no read.
export const WINDOWS_SIDE = process.platform === "win32";

let side: Promise<Side> | undefined;
export const thisSide = (): Promise<Side> =>
    (side ??= WINDOWS_SIDE ? Promise.resolve("windows") : wslEnvironment().then((wsl) => (wsl === undefined ? "native" : "wsl")));
