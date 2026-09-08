// IO half of parse.ts's pure functions: this shells out, parse.ts reads the answer. Nothing here asserts, so a probe is
// reusable by a tier expecting yes and one expecting no (the doctor's "already installed?" wants undefined).

import { errorMessage } from "@intentic/base/errors";
import { desktop, type WindowInfo } from "@intentic/desktop-automation";
import {
    asList,
    containerNames,
    dockerOsType,
    installedApp,
    missingEnvNames,
    publishedPort,
    titled,
    webView2Version,
    type InstalledApp,
    type RunnerTask,
    type UninstallEntry,
} from "./parse.js";
import { powershell, run } from "./run.js";

// Both hives: currentUser install mode puts the app in HKCU, an elevated or per-machine install in HKLM.
const UNINSTALL_KEYS = [
    `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`,
    `HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`,
    `HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`,
];

// WebView2 Runtime's fixed client id in the Edge updater's registry; Microsoft's constant, not ours.
const WEBVIEW2_CLIENT = `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`;

export const findInstalledApp = async (displayName: string): Promise<InstalledApp | undefined> => {
    // -ErrorAction SilentlyContinue: no WOW6432Node hive is an ordinary machine, not a broken one.
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Get-ItemProperty ${UNINSTALL_KEYS.map((key) => `'${key}'`).join(`,`)} |
           Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString |
           ConvertTo-Json -Depth 3 -Compress`,
    );
    return installedApp(asList<UninstallEntry>(result.stdout), displayName);
};

// Reads the registry rather than firing a link: this asks whether the scheme is registered at all, true even before the
// app has ever run.
export const schemeCommand = async (scheme: string): Promise<string | undefined> => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         $key = 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\${scheme}\\shell\\open\\command'
         $value = (Get-ItemProperty -Path $key -Name '(default)').'(default)'
         if (-not $value) {
           $key = 'Registry::HKEY_CLASSES_ROOT\\${scheme}\\shell\\open\\command'
           $value = (Get-ItemProperty -Path $key -Name '(default)').'(default)'
         }
         if ($value) { Write-Output $value }`,
    );
    const command = result.stdout.trim();
    return command === `` ? undefined : command;
};

/** WebView2 runtime's version, or undefined on a machine with none (Windows Server's usual state). */
export const webView2 = async (): Promise<string | undefined> => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}',
           'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}',
           'HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}') |
           ForEach-Object { Get-ItemProperty -Path $_ } |
           Select-Object pv |
           ConvertTo-Json -Compress`,
    );
    return webView2Version(asList<{ pv?: string }>(result.stdout));
};

// Whether this process can see a desktop at all: a runner installed as a Windows service runs in session 0, with no
// window ever mapped, and every assertion after it fails for a reason that isn't the product.
export const userInteractive = async (): Promise<boolean> => {
    const result = await powershell(`[System.Environment]::UserInteractive`);
    return result.stdout.trim().toLowerCase() === `true`;
};

// Repetition read off the triggers, not assumed from the task's existence: a task from before the watchdog existed has
// none. -ErrorAction SilentlyContinue since no task is itself an answer (hand-started), not an error.
export const runnerTask = async (taskName: string): Promise<RunnerTask[]> => {
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Get-ScheduledTask -TaskName '${taskName}' |
           Select-Object @{n='State';e={ [string]$_.State }},
                         @{n='Repetition';e={ ($_.Triggers | Where-Object { $_.Repetition.Interval } |
                                               Select-Object -First 1).Repetition.Interval }} |
           ConvertTo-Json -Depth 3 -Compress`,
    );
    return asList<RunnerTask>(result.stdout);
};

/** Whether a docker CLI is on PATH and its daemon answers. Separate from `dockerContainerOs` on purpose. */
export const dockerReachable = async (): Promise<boolean> => (await run(`docker`, [`info`, `--format`, `{{.OSType}}`])).code === 0;

/** linux or windows, which kind of container this daemon can run. */
export const dockerContainerOs = async (): Promise<string | undefined> => {
    const result = await run(`docker`, [`info`, `--format`, `{{.OSType}}`]);
    return result.code === 0 ? dockerOsType(result.stdout) : undefined;
};

export const dockerInspectRunning = async (container: string): Promise<boolean> => {
    const result = await run(`docker`, [`inspect`, `-f`, `{{.State.Running}}`, container]);
    return result.code === 0 && result.stdout.trim() === `true`;
};

/** The daemon's own answer, read from inside the container so no tunnel or DNS is in the loop. */
export const sandboxHealth = async (container: string): Promise<string | undefined> => {
    const result = await run(`docker`, [`exec`, container, `curl`, `-fsS`, `--max-time`, `10`, `localhost:8787/health`]);
    return result.code === 0 ? result.stdout.trim() : undefined;
};

// Env the run that created this container was actually given; a failed inspect reports every key missing, since a
// container that can't be read carries nothing as far as this can tell.
export const missingContainerEnv = async (container: string, keys: readonly string[]): Promise<string[]> => {
    const result = await run(`docker`, [`inspect`, `-f`, `{{range .Config.Env}}{{println .}}{{end}}`, container]);
    return result.code === 0 ? missingEnvNames(result.stdout, keys) : [...keys];
};

export const dockerLogs = async (container: string, lines: number): Promise<string> => {
    const result = await run(`docker`, [`logs`, `--tail`, String(lines), container]);
    return `${result.stdout}${result.stderr}`;
};

export const removeContainer = async (container: string): Promise<void> => {
    await run(`docker`, [`rm`, `-f`, container]);
};

/** Which host port this container publishes for one of its own, or undefined when it publishes none. */
export const publishedHostPort = async (container: string, containerPort: number): Promise<number | undefined> => {
    const result = await run(`docker`, [`port`, container, `${containerPort}/tcp`]);
    return result.code === 0 ? publishedPort(result.stdout) : undefined;
};

/** Every running container that has claimed a host port, which is how the one holding a derived port is named. */
export const containersPublishing = async (port: number): Promise<string[]> => {
    const result = await run(`docker`, [`ps`, `--filter`, `publish=${port}`, `--format`, `{{.Names}}`]);
    return result.code === 0 ? containerNames(result.stdout) : [];
};

// @intentic/desktop-automation drives the desktop, this repo's Windows counterpart to the Linux tier's xdotool; this is
// the only place that runs it against a real session.
const screen = desktop();

export const windows = async (): Promise<WindowInfo[]> => await screen.windows();

export const windowTitles = async (): Promise<string[]> => (await screen.windows()).map((window) => window.title);

// Filtered by owning process name, never by title: title only says which screen is up, and a same-titled window
// elsewhere (a browser tab) would pass as the app's own. Same identity appRunning uses, compared case-insensitively.
export const appWindows = async (app: string): Promise<WindowInfo[]> =>
    (await screen.windows()).filter((window) => window.app.toLowerCase() === app.toLowerCase());

/** Whether one of the app's own windows is showing the named screen. */
export const appWindowTitled = async (app: string, fragment: string): Promise<boolean> =>
    titled(
        (await appWindows(app)).map((window) => window.title),
        fragment,
    );

// Presses Return only after confirming focus, then verifies success by watching the dialog vanish rather than trusting
// the focus call, since focus can shift (a start-from-cold link's main window stealing it) between the two.
const ANSWER_ATTEMPTS = 3;
const ANSWER_SETTLE_MS = 3_000;
const ANSWER_POLL_MS = 250;

// Window layer the retry loop drives, injectable so tests can fake it; the loop is this file's one real decision (when
// to press again, what silence means).
export interface ConfirmOps {
    /** The dialog's window id, or `undefined` when no window of the app's is showing that title. */
    readonly showing: () => Promise<string | undefined>;
    readonly focus: (id: string) => Promise<void>;
    readonly press: () => Promise<void>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
}

const desktopOps = (app: string, titleFragment: string): ConfirmOps => ({
    showing: async () => (await appWindows(app)).find((window) => window.title.includes(titleFragment))?.id,
    focus: async (id) => await screen.focusWindow(id),
    press: async () => await screen.key(`Return`),
    sleep: async (ms) => await new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
});

export const answerConfirm = async (
    app: string,
    titleFragment: string,
    ops: ConfirmOps = desktopOps(app, titleFragment),
): Promise<string | undefined> => {
    const closed = async (): Promise<boolean> => {
        const deadline = ops.now() + ANSWER_SETTLE_MS;
        for (;;) {
            if ((await ops.showing()) === undefined) {
                return true;
            }
            if (ops.now() >= deadline) {
                return false;
            }
            await ops.sleep(ANSWER_POLL_MS);
        }
    };

    let refusal = `"${titleFragment}" was still up after ${ANSWER_ATTEMPTS} presses of Return, each one sent to a window this machine confirmed had the keyboard`;
    for (let attempt = 1; attempt <= ANSWER_ATTEMPTS; attempt += 1) {
        const dialog = await ops.showing();
        if (dialog === undefined) {
            // Gone before the first press means it was never there; gone after one means the press worked.
            return attempt === 1 ? `no window of ${app}'s is showing "${titleFragment}" any more` : undefined;
        }
        try {
            await ops.focus(dialog);
            await ops.press();
        } catch (error) {
            refusal = errorMessage(error);
            await ops.sleep(ANSWER_POLL_MS);
            continue;
        }
        if (await closed()) {
            return undefined;
        }
    }
    return refusal;
};

/** Fire a link at the OS the way a browser does, `Start-Process`, resolved through the registered handler. */
export const openLink = async (link: string): Promise<void> => {
    await screen.launch(link);
};
