import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { browserTargetPath } from "./cdp.js";
import { BrowserError } from "./types.js";

// Gets a browser that speaks CDP: one this package started, with its own profile under ~/.intentic/browser (one
// directory per browser) and a debugging port the browser picked itself. Only that browser is ever driven. A DevTools
// endpoint found anywhere else, on 9222 or any port, may be a developer's own Chrome with every session they are signed
// into, so it is never adopted: the browser this package started is found again through the port file Chromium writes
// into the profile, and checked against the browser actually answering. The user's own browser, cookies and session
// are never opened or automated.

// The directory name a binary's profile gets: its own filename, so two browsers never share one. Both separators, not
// node's `basename`: a Windows path is parsed here whenever it is read off a Windows registry on a non-Windows build.
export const browserFamily = (binary: string): string => (binary.split(/[/\\]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase() || "browser";

// Beside the agents' homes, never inside one: this package is standalone, and the profile outlives any agent. One per
// browser, not one shared: a user-data-dir records the version that wrote it, and Chromium refuses a profile from a
// newer build than its own — so a machine that ran Edge once would answer a later Brave with a dialog nobody is there
// to dismiss.
export const profileDir = (binary: string): string => join(homedir(), ".intentic", "browser", browserFamily(binary));

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

// The user's own choice, asked of the OS rather than guessed: which app their machine opens a link with. Only a
// Chromium-family answer is usable, since nothing else speaks CDP.
export const defaultBrowser = async (platform: NodeJS.Platform = process.platform): Promise<string | undefined> => {
    const path = platform === "win32" ? await windowsDefault() : platform === "linux" ? await linuxDefault() : undefined;
    return path !== undefined && isChromiumFamily(path) && existsSync(path) ? path : undefined;
};

// The browser an OS installs and points its https association at on its own. Windows does this with Edge, so "the
// default browser is Edge" is as true of a PC whose owner chose it as of one whose owner never chose anything.
export const shippedWithOs = (path: string): boolean => /(msedge|microsoft-edge)/i.test(path);

// Which browser to open, from the OS's answer and what is actually installed (candidate order, most-preferred first).
// The OS default wins, EXCEPT when it is the browser the OS shipped and something else was installed on purpose:
// nobody installs Brave by accident, and an owner who never opened Windows' default-apps pane has not chosen Edge.
// Nothing of theirs rides on the choice either way — this runs on its own profile at profileDir(), never their own, so
// it carries none of their extensions or logins whichever binary starts.
export const pickBrowser = (chosen: string | undefined, installed: readonly string[]): string | undefined => {
    const deliberate = installed.find((path) => !shippedWithOs(path));
    return chosen !== undefined && !(shippedWithOs(chosen) && deliberate !== undefined) ? chosen : (deliberate ?? installed[0]);
};

const findBrowser = async (platform: NodeJS.Platform = process.platform): Promise<string | undefined> =>
    pickBrowser(
        await defaultBrowser(platform),
        browserCandidates(platform).filter((path) => existsSync(path)),
    );

// `--remote-debugging-port=0` has the browser pick a free port and write it, with its own target's path, into the
// profile (ACTIVE_PORT_FILE): a fixed port could already be anybody's. The rest suppress a person-like UI (crash-restore
// prompt, first-run tour, default-browser check).
const flags = (binary: string, url: string | undefined): string[] => [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir(binary)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--restore-last-session=false",
    ...(url === undefined ? [] : [url]),
];

// The file Chromium writes into the profile it runs when it picked its own debugging port: the port on the first line,
// the path of the browser's own debugging target (`/devtools/browser/<id>`, new every start) on the second.
export const ACTIVE_PORT_FILE = "DevToolsActivePort";

export interface ActivePort {
    readonly port: number;
    readonly path: string;
}

export const parseActivePort = (text: string): ActivePort | undefined => {
    const [first, second] = text.split(/\r?\n/);
    const port = Number(first);
    const path = second?.trim() ?? "";
    return Number.isInteger(port) && port > 0 && port < 65_536 && path.startsWith("/devtools/browser/") ? { port, path } : undefined;
};

// Whether the endpoint answering on the file's port is the browser that wrote the file: the target path is new with every
// start, so a file an earlier run left behind, or another browser since given that port, never matches.
export const ownsEndpoint = (file: ActivePort | undefined, answered: string | undefined): boolean => file !== undefined && answered === file.path;

const profilesRoot = (): string => join(homedir(), ".intentic", "browser");

// allow(silent-catch): a profile with no port file has no browser of ours running on it
const activePortIn = async (profile: string): Promise<ActivePort | undefined> => parseActivePort(await readFile(join(profile, ACTIVE_PORT_FILE), "utf8").catch(() => ""));

const ownEndpointIn = async (profile: string): Promise<number | undefined> => {
    const file = await activePortIn(profile);
    return file !== undefined && ownsEndpoint(file, await browserTargetPath(file.port)) ? file.port : undefined;
};

// The debugging port of a browser running one of this package's own profiles, whichever browser it is; undefined when
// none runs. This, and nothing that merely answers on a port, is the browser every action drives.
export const ownEndpoint = async (): Promise<number | undefined> => {
    // allow(silent-catch): no profiles yet is no browser of ours
    const families = await readdir(profilesRoot()).catch((): string[] => []);
    for (const family of families) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a profile or two, each one file and one loopback call
        const port = await ownEndpointIn(join(profilesRoot(), family));
        if (port !== undefined) {
            return port;
        }
    }
    return undefined;
};

// How long a cold browser start is given. Chrome on a laptop that has not run it today is genuinely slow.
const START_TIMEOUT_MS = 20_000;

// Ensures this package's own browser is running and answers its debugging port, reporting whether it had to start one.
// Idempotent: costs a file read and one loopback call when that browser is already up.
export const ensureBrowser = async (url?: string): Promise<{ readonly started: boolean; readonly port: number }> => {
    const running = await ownEndpoint();
    if (running !== undefined) {
        return { started: false, port: running };
    }
    const binary = await findBrowser();
    if (binary === undefined) {
        throw new BrowserError(
            "This computer has no Brave, Chrome, Chromium or Edge, and browser control needs one of them.",
            "Install Brave (or Google Chrome) and try again.",
        );
    }
    const profile = profileDir(binary);
    // What an earlier run left there would answer the wait below with a port that is not this start's.
    await rm(join(profile, ACTIVE_PORT_FILE), { force: true });
    // Detached with streams discarded: the browser must outlive this call and not block on an undrained pipe.
    const child = spawn(binary, flags(binary, url), { detached: true, stdio: "ignore" });
    child.unref();
    let port: number | undefined;
    const answered = async (): Promise<boolean> => {
        port = await ownEndpointIn(profile);
        return port !== undefined;
    };
    if (!(await pollUntil(answered, { intervalMs: 150, timeoutMs: START_TIMEOUT_MS })) || port === undefined) {
        throw new BrowserError(
            "The browser did not open its debugging port in time.",
            `If a window of it is still open from before, with the profile in ${profile}, close it and try again: a browser already running that profile ignores what a new start asks of it.`,
        );
    }
    return { started: true, port };
};
