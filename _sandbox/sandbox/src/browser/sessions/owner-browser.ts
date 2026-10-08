import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { Browser, BrowserContext } from "playwright";
import { z } from "zod";
import type { BrowserFingerprint } from "./fingerprint.js";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { spawnAs } from "../../workload/workload-class.js";

// The owner's own sign-in window: Chromium started as a plain process, with Playwright attached afterwards over CDP.
// Not launchPersistentContext: X's sign-in risk check refused a Google sign-in from every Playwright-launched window
// ("An unexpected error occurred") while the same binary, profile and address signed in when started plainly, with or
// without Playwright attached later. So everything a launch used to set through CDP comes from the process instead:
// the clock from TZ, the language from LANGUAGE and the profile's own preference, the proxy from --proxy-server.
// They are what a real machine would report anyway, with no emulation layer for a page to catch disagreeing with itself.

// Written by Chromium into the profile once it has picked its own debugging port (--remote-debugging-port=0): the port
// on the first line. A fixed port could already be anybody's.
const ACTIVE_PORT_FILE = "DevToolsActivePort";

// Not a Chromium switch (Chromium ignores it, and no page can see a command line): it marks the process as an owner's
// window, so a later launch can tell one a crashed daemon left running from the agent's own browser on the profile.
export const OWNER_WINDOW_FLAG = "--intentic-owner-window";

// Cold start on a busy container, the same budget browser-sessions.ts gives an attach.
const START_TIMEOUT_MS = 30_000;
// How long a graceful Browser.close gets to flush cookies before the process is killed.
const CLOSE_TIMEOUT_MS = 10_000;

export interface OwnerBrowserOptions {
    readonly executablePath: string;
    readonly userDataDir: string;
    readonly display: string;
    readonly fingerprint: BrowserFingerprint;
    // socks5://127.0.0.1:<port> of a bound exit; absent leaves by the sandbox's own address.
    readonly proxy?: string | undefined;
    // Window placement on the display (chromiumWindowArgs).
    readonly windowArgs: readonly string[];
}

export interface OwnerBrowser {
    // The profile's own context: the one Chromium opened, not one Playwright made.
    readonly context: BrowserContext;
    // Its DevTools HTTP endpoint, http://127.0.0.1:<port>: what a video view reads the tab in front off (front-tab.ts).
    readonly endpoint: string;
    // Closes Chromium gracefully (cookies flushed to the profile), killing it only if it does not exit in time.
    readonly close: () => Promise<void>;
}

// Flags the window runs with. Kept to what the window itself needs: Playwright's own default switches are not passed.
// --no-sandbox: the container is the isolation boundary, running as root.
// --disable-dev-shm-usage: avoids crashing on a container's tiny /dev/shm.
// --disable-blink-features=AutomationControlled: navigator.webdriver stays false, as on any desktop.
// --disable-infobars: no "Chrome for Testing" bar over the page in the owner's picture.
export const ownerBrowserArgs = (options: Omit<OwnerBrowserOptions, "executablePath" | "display">): string[] => [
    OWNER_WINDOW_FLAG,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${options.userDataDir}`,
    ...(options.proxy === undefined ? [] : [`--proxy-server=${options.proxy}`]),
    ...options.windowArgs,
    "about:blank",
];

// Chromium on Linux takes its own locale (Intl's default) from LANGUAGE, ignoring --lang; glibc spells it de_DE.
export const localeEnv = (locale: string): string => locale.replace("-", "_");

// Preferences a person sets in Settings, written before each launch so the profile holds them whatever was clicked
// since. A Preferences file this cannot read is left for Chromium, never written over.
//
// navigator.language(s) and Accept-Language come from the profile's language list (--accept-lang only reaches a
// headless browser), so it follows the fingerprint, a bound exit's country included.
//
// Translate's offer is off: the window leaves by the sandbox's own address, so a site answers in that country's
// language, and Chromium offered to translate nearly every page with a bubble over its top corner. Over a remote
// picture that bubble is a piece of browser chrome that can't be told from the page and covers it (2026-10-08). Pages
// cannot see the setting.
// The two sections written, read as far as this needs them; every other key, in them and beside them, is carried
// through untouched.
const PreferencesSchema = z.looseObject({
    intl: z.looseObject({ accept_languages: z.unknown().optional(), selected_languages: z.unknown().optional() }).optional(),
    translate: z.looseObject({ enabled: z.unknown().optional() }).optional(),
});

const readPreferences = async (path: string): Promise<z.infer<typeof PreferencesSchema> | undefined> => {
    // A profile never started has no file yet, which is a profile with nothing set.
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return {};
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        // allow(silent-catch): a file Chromium is mid-way through writing is its own, and left to it.
        return undefined;
    }
    const parsed = PreferencesSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
};

export const seedPreferences = async (userDataDir: string, languages: readonly string[]): Promise<void> => {
    const path = join(userDataDir, "Default", "Preferences");
    // allow(silent-catch): a file that cannot be read (permissions, a directory in its place) is left for Chromium.
    const prefs = await readPreferences(path).catch(() => undefined);
    if (prefs === undefined) {
        return;
    }
    const wanted = languages.join(",");
    if (prefs.intl?.accept_languages === wanted && prefs.intl.selected_languages === wanted && prefs.translate?.enabled === false) {
        return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        JSON.stringify({
            ...prefs,
            intl: { ...prefs.intl, accept_languages: wanted, selected_languages: wanted },
            translate: { ...prefs.translate, enabled: false },
        }),
    );
};

// Every window starts with only the tab it is opened for. Chromium keeps the last windows' tabs in the profile's
// Sessions directory, and the --hide-crash-restore-bubble a window needs (no "Restore pages?" bubble over the picture)
// also tells it to reopen them, unasked, whenever the last run did not end cleanly: and a daemon restarting ends every
// window uncleanly. The person's own window came back after a sandbox update with every tab it had before beside the
// one they asked for, the picture on a tab the strip did not select (2026-10-08). Cookies, storage and sign-ins live
// elsewhere in the profile and stay.
export const forgetTabs = async (userDataDir: string): Promise<void> => {
    await rm(join(userDataDir, "Default", "Sessions"), { recursive: true, force: true });
};

export const parseActivePort = (text: string): number | undefined => {
    const port = Number(text.split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
};

// Whether one process's arguments are an owner's window on this profile: the browser process itself, not one of its
// helpers (--type=renderer and the like).
export const isOwnerWindow = (argv: readonly string[], userDataDir: string): boolean =>
    argv.includes(OWNER_WINDOW_FLAG) && argv.includes(`--user-data-dir=${userDataDir}`) && !argv.some((arg) => arg.startsWith("--type="));

// Playwright's launch tied the browser's life to the daemon's through its pipe; a plain process outlives a daemon that
// crashes, holding the profile so every later window on it fails to start. The route's profile lock means no window
// of this daemon's is open on the profile when this runs, so a marked browser still on it is one of those, and goes.
const reapOrphans = async (userDataDir: string): Promise<void> => {
    // allow(silent-catch): no /proc is a platform with nothing of ours to reap
    const pids = (await readdir("/proc").catch((): string[] => [])).filter((name) => /^\d+$/.test(name));
    const orphans: number[] = [];
    for (const pid of pids) {
        // allow(silent-catch): a process gone between the listing and the read is no window left to reap
        // oxlint-disable-next-line eslint/no-await-in-loop -- one small file per process, once per window opened
        const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
        if (isOwnerWindow(argv, userDataDir)) {
            orphans.push(Number(pid));
        }
    }
    for (const pid of orphans) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // allow(silent-catch): already gone between the scan and the kill.
        }
    }
    // Chromium refuses a profile whose lock names a live pid; a killed one is cleared on the next start.
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (orphans.some((pid) => existsSync(`/proc/${String(pid)}`)) && Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- waiting on the kernel to finish the kill
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const waitForPort = async (child: ChildProcess, file: string): Promise<number> => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`the browser exited while starting (${child.exitCode ?? child.signalCode})`);
        }
        // allow(silent-catch): no file yet is a browser still starting
        const port = parseActivePort(await readFile(file, "utf8").catch(() => ""));
        if (port !== undefined) {
            return port;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling one file until Chromium writes it
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the browser did not open its debugging port within ${START_TIMEOUT_MS / 1000}s`);
};

const exited = (child: ChildProcess, ms: number): Promise<boolean> =>
    child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve(true)
        : new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), ms);
              child.once("exit", () => {
                  clearTimeout(timer);
                  resolve(true);
              });
          });

export const launchOwnerBrowser = async (playwright: typeof import("playwright"), options: OwnerBrowserOptions): Promise<OwnerBrowser> => {
    if (!existsSync(options.executablePath)) {
        throw new Error("browser not installed, rebuild the sandbox (Environment card) first");
    }
    // A file a previous run left behind would name a port nobody answers on any more.
    const portFile = join(options.userDataDir, ACTIVE_PORT_FILE);
    await reapOrphans(options.userDataDir);
    await rm(portFile, { force: true });
    await forgetTabs(options.userDataDir);
    await seedPreferences(options.userDataDir, options.fingerprint.languages);
    // Ranked as a service for the OOM killer: after an agent's command, before a turn's runtime.
    const child = spawnAs({ class: "service" }, options.executablePath, ownerBrowserArgs(options), {
        // Stamped, so a window its daemon left open when it died is ended at the next boot (system/boot/generation-sweep.ts).
        env: {
            ...process.env,
            ...detachedStamp("login-browser"),
            DISPLAY: options.display,
            TZ: options.fingerprint.timezoneId,
            LANGUAGE: localeEnv(options.fingerprint.locale),
        },
        stdio: "ignore",
    });
    let browser: Browser | undefined;
    let endpoint: string;
    try {
        endpoint = `http://127.0.0.1:${await waitForPort(child, portFile)}`;
        browser = await playwright.chromium.connectOverCDP(endpoint);
    } catch (err) {
        child.kill("SIGKILL");
        throw err;
    }
    const context = browser.contexts()[0];
    if (context === undefined) {
        child.kill("SIGKILL");
        throw new Error("the browser opened without its profile's context");
    }
    const attached = browser;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        closing ??= (async () => {
            // Browser.close is Chromium's own orderly shutdown, which writes cookies out; Playwright's close() on a
            // connected browser only disconnects.
            await attached
                .newBrowserCDPSession()
                .then((cdp) => cdp.send("Browser.close"))
                // allow(silent-catch): a browser already gone has nothing left to flush
                .catch(() => undefined);
            if (!(await exited(child, CLOSE_TIMEOUT_MS))) {
                child.kill("SIGKILL");
            }
        })();
        return closing;
    };
    return { context, endpoint, close };
};
