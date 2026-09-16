import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probe, waitForPort } from "./cdp.js";
import { BrowserError } from "./types.js";

// Gets a browser that speaks CDP; only one started with --remote-debugging-port qualifies, so an existing endpoint
// is reused if present, else a separate instance launches with its own profile at ~/.intentic/browser. The
// user's own browser, cookies and session are never opened or automated.

// Fixed rather than random, so a user can find it and a restart can reconnect to the browser it left running.
export const DEFAULT_PORT = 9222;

// Beside the agents' homes, never inside one: this package is standalone, and the profile outlives any agent.
export const profileDir = (): string => join(homedir(), ".intentic", "browser");

// Only a Chromium-family binary speaks CDP, so a default of Firefox or Safari is a reason to fall back to the
// guesses rather than to fail. Matches the name Edge, Brave, Opera and Vivaldi each ship under.
export const isChromiumFamily = (path: string): boolean => /(chrome|chromium|edge|brave|vivaldi|opera|thorium)/i.test(path);

// The guesses, used only when the OS will not say which browser is the user's. Most-preferred first, and a
// deliberately installed browser outranks the one the OS shipped: nobody installs Brave by accident, and every
// Windows has Edge whether its owner wanted one or not.
export const browserCandidates = (platform: NodeJS.Platform): string[] => {
    if (platform === "win32") {
        const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
        const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
        const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
        return [
            join(programFiles, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
            join(programFilesX86, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
            join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
            join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
            join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
            join(local, "Google\\Chrome\\Application\\chrome.exe"),
            join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
            join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
        ];
    }
    return [
        "/usr/bin/brave-browser",
        "/usr/bin/brave-browser-stable",
        "/snap/bin/brave",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
    ];
};

// A probe of the OS, not of a page: short, because a wedged one must not hold up a browser start.
const PROBE_TIMEOUT_MS = 3_000;

const run = async (command: string, args: string[]): Promise<string> =>
    await new Promise((resolve) => {
        execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : ""));
    });

// The value half of a `reg query` line: "    (Default)    REG_SZ    C:\path\to\thing". reg.exe separates the
// three columns with four spaces, and a value may itself contain spaces, so only the separator can be matched on.
export const registryValue = (output: string): string | undefined => output.match(/REG_[A-Z_]+\s{2,}(.+)$/m)?.[1]?.trim();

// A registered open command is an executable plus its own arguments: `"C:\…\brave.exe" --single-argument %1`.
export const executableFromCommand = (command: string): string | undefined => {
    const trimmed = command.trim();
    const path = trimmed.startsWith(`"`) ? trimmed.slice(1).split(`"`)[0] : trimmed.split(/\s+/)[0];
    return path === undefined || path === "" ? undefined : path;
};

// The Exec line of a .desktop entry, minus the field codes (%u, %U, %f) the spec has the launcher substitute.
export const executableFromDesktopEntry = (contents: string): string | undefined => {
    const exec = contents.match(/^Exec=(.+)$/m)?.[1]?.trim();
    if (exec === undefined) {
        return undefined;
    }
    const command = exec.replace(/%[a-zA-Z]/g, "").trim();
    return executableFromCommand(command);
};

// Windows records the choice made in Settings ▸ Default apps against the https scheme; the ProgId it names is a
// key under HKCR whose open command holds the path. https rather than http: it is the scheme a browser is chosen for.
const windowsDefault = async (): Promise<string | undefined> => {
    const reg = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");
    const choice = await run(reg, [
        "query",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
        "/v",
        "ProgId",
    ]);
    const progId = registryValue(choice);
    // Interpolated into a registry path below, so anything that is not a plain identifier is refused rather than run.
    if (progId === undefined || !/^[A-Za-z0-9._-]+$/.test(progId)) {
        return undefined;
    }
    const command = registryValue(await run(reg, ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"]));
    return command === undefined ? undefined : executableFromCommand(command);
};

// Where a desktop entry can live, in the order the spec searches: the user's own overrides the system's.
const desktopEntryDirs = (): string[] => {
    const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
    const dataDirs = (process.env["XDG_DATA_DIRS"] ?? "/usr/local/share:/usr/share").split(":").filter((dir) => dir !== "");
    return [dataHome, ...dataDirs, "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"].map((dir) => join(dir, "applications"));
};

const readDesktopEntry = (name: string): string | undefined => {
    for (const dir of desktopEntryDirs()) {
        const path = join(dir, name);
        if (existsSync(path)) {
            return readFileSync(path, "utf8");
        }
    }
    return undefined;
};

// A bare command in an Exec line is resolved against PATH by the launcher; these are the three places a browser
// package puts one.
const resolveBin = (command: string): string | undefined => {
    if (command.includes("/")) {
        return existsSync(command) ? command : undefined;
    }
    return ["/usr/bin", "/usr/local/bin", "/snap/bin"].map((dir) => join(dir, command)).find((path) => existsSync(path));
};

const linuxDefault = async (): Promise<string | undefined> => {
    const name =
        (await run("xdg-settings", ["get", "default-web-browser"])).trim() ||
        (await run("xdg-mime", ["query", "default", "x-scheme-handler/https"])).trim();
    if (name === "" || !name.endsWith(".desktop")) {
        return undefined;
    }
    const entry = readDesktopEntry(name);
    const exec = entry === undefined ? undefined : executableFromDesktopEntry(entry);
    return exec === undefined ? undefined : resolveBin(exec);
};

// The user's own choice first, asked of the OS rather than guessed: the browser they set as default is the one
// their extensions, and the logins they will be asked to perform, are in. Only a Chromium-family answer is usable.
export const defaultBrowser = async (platform: NodeJS.Platform = process.platform): Promise<string | undefined> => {
    const path = platform === "win32" ? await windowsDefault() : platform === "linux" ? await linuxDefault() : undefined;
    return path !== undefined && isChromiumFamily(path) && existsSync(path) ? path : undefined;
};

const findBrowser = async (): Promise<string | undefined> =>
    (await defaultBrowser()) ?? browserCandidates(process.platform).find((path) => existsSync(path));

// `--remote-debugging-port` is the point; the rest suppress a person-like UI (crash-restore prompt, first-run
// tour, default-browser check).
const flags = (port: number, url: string | undefined): string[] => [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--restore-last-session=false",
    ...(url === undefined ? [] : [url]),
];

// How long a cold browser start is given. Chrome on a laptop that has not run it today is genuinely slow.
const START_TIMEOUT_MS = 20_000;

// Ensures something listens on the debugging port and reports whether it had to start one. Idempotent: costs one
// loopback probe when a browser is already up.
export const ensureBrowser = async (port: number = DEFAULT_PORT, url?: string): Promise<{ started: boolean }> => {
    if (await probe(port)) {
        return { started: false };
    }
    const binary = await findBrowser();
    if (binary === undefined) {
        throw new BrowserError(
            "This computer has no Brave, Chrome, Chromium or Edge, and browser control needs one of them.",
            "Install Brave (or Google Chrome) and try again.",
        );
    }
    // Detached with streams discarded: the browser must outlive this call and not block on an undrained pipe.
    const child = spawn(binary, flags(port, url), { detached: true, stdio: "ignore" });
    child.unref();
    await waitForPort(port, START_TIMEOUT_MS);
    return { started: true };
};
