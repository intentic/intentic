import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probe, waitForPort } from "./cdp.js";
import { BrowserError } from "./types.js";

/* Getting a browser that will talk to us.
 *
 * WHY NOT THE ONE THE USER ALREADY HAS OPEN. A browser only speaks CDP if it was started with
 * `--remote-debugging-port`, and nobody's everyday browser was. Restarting theirs to add the flag would close
 * every tab they had open, which is not a thing an agent should do to somebody mid-afternoon. So: if a debugging
 * endpoint is ALREADY there, use it (the user, or another tool, opened one deliberately); otherwise start a
 * SEPARATE instance with its own profile directory.
 *
 * THE SEPARATE PROFILE IS A FEATURE, not a compromise. It is empty the first time, so the user signs into
 * whatever the agent needs to reach — once, in a window they can watch — and that profile persists under
 * ~/.intentic/host/browser afterwards. Their own browser, with their own cookies and their own session, is never
 * opened, never automated, and never at risk from a misfired click. */

// The default port. Fixed rather than random so a user can find it, and so a reconnect after a restart of this
// agent finds the browser it left running instead of orphaning it.
export const DEFAULT_PORT = 9222;

export const profileDir = (): string => join(homedir(), ".intentic", "host", "browser");

/* Where a Chromium-family browser lives, per platform, most-preferred first. Chrome, Edge and Chromium all speak
 * the same protocol, so any of them will do — and on a machine with none of them the message says exactly that
 * rather than failing at a spawn. */
export const browserCandidates = (platform: NodeJS.Platform): string[] => {
    if (platform === "win32") {
        const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
        const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
        const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
        return [
            join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
            join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
            join(local, "Google\\Chrome\\Application\\chrome.exe"),
            join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
            join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
        ];
    }
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
    ];
};

const findBrowser = (): string | undefined => browserCandidates(process.platform).find((path) => existsSync(path));

/* The flags. `--remote-debugging-port` is the point; the rest keep a browser started by an agent from behaving
 * like one started by a person — no "restore your tabs?" prompt after a crash, no first-run tour standing
 * between the agent and the page, and no attempt to become the default browser on somebody's machine. */
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

/* Ensure something is listening on the debugging port, and say whether we had to start it. Idempotent: called
 * before every operation, it costs one loopback probe when a browser is already up. */
export const ensureBrowser = async (port: number = DEFAULT_PORT, url?: string): Promise<{ started: boolean }> => {
    if (await probe(port)) {
        return { started: false };
    }
    const binary = findBrowser();
    if (binary === undefined) {
        throw new BrowserError(
            "This computer has no Chrome, Chromium or Edge, and browser control needs one of them.",
            "Install Google Chrome (or Chromium) and try again.",
        );
    }
    // Detached with its streams discarded: the browser must outlive the call that started it, and a browser
    // writing to a pipe nobody drains eventually blocks.
    const child = spawn(binary, flags(port, url), { detached: true, stdio: "ignore" });
    child.unref();
    await waitForPort(port, START_TIMEOUT_MS);
    return { started: true };
};
