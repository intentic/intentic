/* Asking the machine under test what is true. Every function here is the IO half of a pure function in
 * `parse.ts` — the shell round trip lives here, the reading of its answer lives there.
 *
 * Nothing in this file asserts. A probe answers a question; whether the answer is a pass is the tier's
 * business, and keeping that line means a probe can be reused by a tier that expects "no" (the doctor's
 * "is the app already installed?", which wants `undefined`) and by one that expects "yes".
 */

import { desktop, type WindowInfo } from "@intentic/desktop";
import { asList, dockerOsType, installedApp, titled, webView2Version, type InstalledApp, type UninstallEntry } from "./parse.js";
import { powershell, run } from "./run.js";

/* Where Windows lists what is installed. Both hives, because `installMode: currentUser` in the bundle config
 * puts the app in HKCU — but an installer run elevated, or a future switch to a per-machine install, lands in
 * HKLM, and a probe that reads one hive would report a perfectly good install as absent. */
const UNINSTALL_KEYS = [
    `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`,
    `HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`,
    `HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*`,
];

// The WebView2 Runtime's fixed client id in the Edge updater's registry. A constant of Microsoft's, not ours.
const WEBVIEW2_CLIENT = `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`;

export const findInstalledApp = async (displayName: string): Promise<InstalledApp | undefined> => {
    // -ErrorAction SilentlyContinue on the whole pipeline: a machine with no WOW6432Node hive is an ordinary
    // machine, not a broken one, and its error would otherwise be the only thing on stdout.
    const result = await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Get-ItemProperty ${UNINSTALL_KEYS.map((key) => `'${key}'`).join(`,`)} |
           Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString |
           ConvertTo-Json -Depth 3 -Compress`,
    );
    return installedApp(asList<UninstallEntry>(result.stdout), displayName);
};

/* What the OS would run for `intentic://…`.
 *
 * The registry is read rather than a link being fired, because these are two different questions and the tier
 * asks both: this one is "is the scheme registered, and to what", which has a meaningful answer BEFORE the app
 * has ever run — the state a user who just installed is in, and the state in which the Linux equivalent of
 * this chain was broken for months while every after-launch assertion passed. */
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

/** The WebView2 runtime's version, or `undefined` on a machine that has none — Windows Server's usual state. */
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

/* Whether this process can see a desktop at all.
 *
 * The single most valuable line in the doctor, because it is the one precondition whose absence makes EVERY
 * other assertion in tier 1 fail for a reason that has nothing to do with the product. A GitHub Actions runner
 * installed as a Windows service runs in session 0, which has no interactive desktop: the app starts, no window
 * is ever mapped, and a log full of "the workspace window opened (waited 60s)" reads exactly like a broken
 * build. The runner has to be started from a logged-in session. */
export const userInteractive = async (): Promise<boolean> => {
    const result = await powershell(`[System.Environment]::UserInteractive`);
    return result.stdout.trim().toLowerCase() === `true`;
};

/** Whether a docker CLI is on PATH and its daemon answers. Separate from `dockerContainerOs` on purpose. */
export const dockerReachable = async (): Promise<boolean> => (await run(`docker`, [`info`, `--format`, `{{.OSType}}`])).code === 0;

/** `linux` or `windows` — which kind of container this daemon can run. See `parse.ts` for why it is asked. */
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

export const dockerLogs = async (container: string, lines: number): Promise<string> => {
    const result = await run(`docker`, [`logs`, `--tail`, String(lines), container]);
    return `${result.stdout}${result.stderr}`;
};

export const removeContainer = async (container: string): Promise<void> => {
    await run(`docker`, [`rm`, `-f`, container]);
};

/* The window layer. `@intentic/desktop` rather than a P/Invoke of our own: it is this repo's own answer to
 * "drive a Windows desktop from Node", it is the exact counterpart of the `xdotool` the Linux tier leans on,
 * and using it here means the installer tier is also the only place that runs it against a real Windows
 * session — which no unit test of it can be. */
const screen = desktop();

export const windows = async (): Promise<WindowInfo[]> => await screen.windows();

export const windowTitles = async (): Promise<string[]> => (await screen.windows()).map((window) => window.title);

/* THE APP'S OWN WINDOWS, BY THE PROGRAM THAT OWNS THEM — never by title.
 *
 * Every window question this tier asks is about the app under test, and the title is only ever which SCREEN is
 * up. Selecting by title conflates the two, and on any desktop that is not empty it silently answers about
 * somebody else's window: a browser tab reading the product's docs is titled `Intentic …`, which is enough to
 * make "the app closed" never come true and "one window, not two" count to three. It also cuts the other way —
 * on a machine where only the browser is open, "the workspace window opened" passes with no app at all.
 *
 * `app` is the process name Windows reports for the window's owning process (`intentic-desktop`), so this is
 * the same identity `appRunning` uses. Compared case-insensitively because the casing is the OS's business. */
export const appWindows = async (app: string): Promise<WindowInfo[]> =>
    (await screen.windows()).filter((window) => window.app.toLowerCase() === app.toLowerCase());

/** Whether one of the APP's own windows is showing the named screen. */
export const appWindowTitled = async (app: string, fragment: string): Promise<boolean> =>
    titled(
        (await appWindows(app)).map((window) => window.title),
        fragment,
    );

/* Say yes to the confirmation the app raises for a link it did not watch its own window ask for.
 *
 * Focus first, and assert the focus: text goes to whatever window HAS the keyboard, not to the one most
 * recently created, and a Return sent to the wrong window is a keystroke delivered somewhere in the CI
 * desktop with no trace. Return rather than a click, for the same reason the Linux tier presses Return: the
 * affirmative button's position is the dialog's business and changes with the copy in it, while "the default
 * button" is what the platform promises.
 *
 * Scoped to the app's own windows for the reason above, and here it is not merely a wrong answer: a Return
 * aimed by title alone can land in whatever the person at this desk happens to have open.
 *
 * IT ANSWERS WITH WHY, NOT WITH FALSE. A keystroke that was never delivered is invisible from here on: the
 * assertions after it wait out their deadlines on a screen that was never going to come, and the log blames
 * the setup screen for a Return that landed on somebody's browser. `focusWindow` is the one step that CAN
 * tell, so its refusal is carried out to the tier verbatim rather than collapsed into a boolean — the
 * difference between "this machine would not give the dialog the keyboard" and thirty seconds of silence.
 *
 * AND FOCUS ALONE IS NOT ENOUGH TO TELL, WHICH IS WHY THE DIALOG GOING AWAY IS THE PROOF. `focusWindow`
 * reports the foreground as it stands when it returns; the keystroke is a separate round trip, and in the gap
 * between them the foreground can move. It DOES move, on the one path this matters most: a link that arrives
 * while the app is not running starts the app, the dialog is the first thing that maps, and the app's own main
 * window maps a second or two later and takes the keyboard with it. The Return then lands in the workspace,
 * the dialog stays up untouched, and every assertion after it fails describing a product that was never asked.
 * That is a race, not a machine that refused, so the answer is to look and press again rather than to give up
 * — and the only reading that settles it is the dialog being gone. */
const ANSWER_ATTEMPTS = 3;
const ANSWER_SETTLE_MS = 3_000;
const ANSWER_POLL_MS = 250;

/* The window layer the loop below drives, named so it can be handed a fake. The loop is the only thing in this
 * file that is a DECISION rather than a round trip — when to press again, and which silence is a pass — and
 * `createHarness` sets the precedent for injecting the clock and the sleep to test one. */
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
            if ((await ops.showing()) === undefined) return true;
            if (ops.now() >= deadline) return false;
            await ops.sleep(ANSWER_POLL_MS);
        }
    };

    let refusal = `"${titleFragment}" was still up after ${ANSWER_ATTEMPTS} presses of Return, each one sent to a window this machine confirmed had the keyboard`;
    for (let attempt = 1; attempt <= ANSWER_ATTEMPTS; attempt += 1) {
        const dialog = await ops.showing();
        if (dialog === undefined) {
            // Gone before the first press is the dialog never having been there to answer; gone after one is
            // the press that worked, arriving while this was still looking.
            return attempt === 1 ? `no window of ${app}'s is showing "${titleFragment}" any more` : undefined;
        }
        try {
            await ops.focus(dialog);
            await ops.press();
        } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
            await ops.sleep(ANSWER_POLL_MS);
            continue;
        }
        if (await closed()) return undefined;
    }
    return refusal;
};

/** Fire a link at the OS the way a browser does — `Start-Process`, resolved through the registered handler. */
export const openLink = async (link: string): Promise<void> => {
    await screen.launch(link);
};
