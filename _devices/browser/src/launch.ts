import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probe, waitForPort } from "./cdp.js";
import { BrowserError } from "./types.js";

// Gets a browser that speaks CDP; only one started with --remote-debugging-port qualifies, so an existing endpoint
// is reused if present, else a separate instance launches with its own profile at ~/.intentic/host/browser. The
// user's own browser, cookies and session are never opened or automated.

// Fixed rather than random, so a user can find it and a restart can reconnect to the browser it left running.
export const DEFAULT_PORT = 9222;

export const profileDir = (): string => join(homedir(), ".intentic", "host", "browser");

// Where a Chromium-family browser lives, per platform, most-preferred first; Chrome/Edge/Chromium all speak the
// same protocol.
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
    const binary = findBrowser();
    if (binary === undefined) {
        throw new BrowserError(
            "This computer has no Chrome, Chromium or Edge, and browser control needs one of them.",
            "Install Google Chrome (or Chromium) and try again.",
        );
    }
    // Detached with streams discarded: the browser must outlive this call and not block on an undrained pipe.
    const child = spawn(binary, flags(port, url), { detached: true, stdio: "ignore" });
    child.unref();
    await waitForPort(port, START_TIMEOUT_MS);
    return { started: true };
};
