// Tier 1: does the Windows installer install, launch, and answer a deep link, with no Docker or credentials (loopback
// stand-ins), so it can gate every release.
// 1. install, including a WebView2 fetch on a runtime-less machine
// 2. on disk: the executable and the scripts it spawns
// 3. intentic:// registered before the app's first run, since the app rewrites it after
// 4. the deep link, with the app not running and already running (different mechanisms)
// 5. uninstall while the app is running (the ordinary state, since it lives in the tray)

import type { WindowInfo } from "@intentic/desktop-automation";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { appExecutable, appRunning, installSilently, launchApp, quitApp, uninstallSilently } from "./app.js";
import { APP_IDENTIFIER, CONFIRM_TITLE, PRODUCT_NAME, SCHEME, SETUP_LINK, SETUP_TITLE, WORKSPACE_TITLE } from "./constants.js";
import type { Harness } from "./harness.js";
import { prepareHermeticDesktop } from "./hermetic.js";
import { answerConfirm, appWindowTitled, appWindows, findInstalledApp, openLink, schemeCommand, webView2, windowTitles } from "./probe.js";

export interface InstallTierOptions {
    /** The Intentic-<version>-x64-setup.exe under test. */
    readonly installer: string;
    /** When this is a release gate, the version Windows must read back from the installed candidate. */
    readonly expectedVersion: string | undefined;
    /** Where the app's workspace window should point; a stub origin keeps this tier hermetic. */
    readonly appUrl: string | undefined;
    /** Leave the app installed when the tier finishes; tier 2 needs it, since it runs the installed scripts. */
    readonly keepInstalled: boolean;
}

const WINDOW_SETTLE_SECONDS = 60;
const LINK_SECONDS = 45;
// A cold first launch also initializes WebView2's user-data directory, which is slower than a warm one.
const SCREEN_SECONDS = 60;

// Single-instance plugin's own hidden window (15×15 at the origin), named so window counts by owning program can
// exclude it.
const SINGLE_INSTANCE_WINDOW = `${APP_IDENTIFIER}-siw`;

/** One window's title and rectangle as a string, so a failed count can print what it counted. */
const box = (window: WindowInfo): string => `${window.title} — ${window.bounds.x},${window.bounds.y} ${window.bounds.width}×${window.bounds.height}`;

const describeWindows = async (): Promise<string> => {
    const titles = await windowTitles();
    return titles.length === 0 ? `(no windows)` : titles.map((title) => `- ${title}`).join(`\n`);
};

// Recorded only on refusal: a lost keystroke would otherwise leave later assertions timing out and reading as the app's
// fault.
const answer = (harness: Harness, refusal: string | undefined): void => {
    if (refusal !== undefined) {
        harness.fail(`the confirmation could not be answered`, refusal);
    }
};

export const runInstallTier = async (harness: Harness, options: InstallTierOptions): Promise<void> => {
    if (!existsSync(options.installer)) {
        harness.fail(`the installer is not at ${options.installer}`);
        return;
    }

    const hermetic = await prepareHermeticDesktop(options.appUrl);
    try {
        // Recorded, not asserted: a missing runtime is legitimate, but changes what a launch failure means afterward.
        const runtimeBefore = await webView2();
        harness.section(`the machine, before`);
        harness.pass(`WebView2 runtime: ${runtimeBefore ?? `absent, the installer's bootstrapper has to fetch one`}`);

        const already = await findInstalledApp(PRODUCT_NAME);
        if (already !== undefined) {
            // Not a failure to recover from: installing over an existing one is a different code path, unasserted here.
            harness.fail(
                `${PRODUCT_NAME} ${already.version ?? ``} is already installed at ${already.installLocation}`,
                `This tier asserts a FIRST install on a clean machine. Reset the runner's snapshot, or uninstall by hand:\n  ${already.uninstallString} /S`,
            );
            return;
        }

        // 1. install
        harness.section(`install`);
        const install = await installSilently(options.installer);
        if (install.code === 0) {
            harness.pass(`the installer completed unattended`);
        } else {
            harness.fail(`the installer exited ${install.code}`, `${install.stdout}${install.stderr}`);
            return;
        }

        const installed = await findInstalledApp(PRODUCT_NAME);
        if (installed === undefined) {
            harness.fail(
                `Windows does not list ${PRODUCT_NAME} as installed`,
                `The installer reported success, so this is a bundler-side regression: nothing wrote the uninstall entry that Add/Remove Programs reads.`,
            );
            return;
        }
        harness.pass(`Windows lists it: ${installed.name} ${installed.version ?? `(no version)`} at ${installed.installLocation}`);
        if (options.expectedVersion !== undefined) {
            if (installed.version === options.expectedVersion) {
                harness.pass(`the installed candidate is release ${options.expectedVersion}`);
            } else {
                harness.fail(`Windows installed version ${installed.version ?? `(none)`}, expected ${options.expectedVersion}`);
            }
        }

        // 2. on disk
        harness.section(`on disk`);
        const executable = await appExecutable(installed.installLocation);
        if (executable === undefined) {
            harness.fail(`no executable in ${installed.installLocation}`);
            return;
        }
        harness.pass(`executable at ${executable}`);
        // Process name Windows derives from the executable's base name; window assertions match on this, not title.
        const app = basename(executable, `.exe`);

        // verify-desktop-bundle.sh checks the bundled bytes match source; this checks the install actually placed them.
        const scripts = join(installed.installLocation, `scripts`);
        const shipped = [`connect.ps1`, `recreate.ps1`, `cleanup.ps1`];
        const missing = shipped.filter((script) => !existsSync(join(scripts, script)));
        if (missing.length === 0) {
            harness.pass(`bundled scripts installed at ${scripts}`);
        } else {
            harness.fail(`the bundled scripts are not on disk after install: ${missing.join(`, `)}`);
        }

        // 3. scheme registration, before first launch
        harness.section(`scheme registration, before first launch`);
        const registered = await schemeCommand(SCHEME);
        if (registered === undefined) {
            harness.fail(
                `nothing is registered for ${SCHEME}://`,
                `Every ${SCHEME}:// link would go nowhere for a user who has just installed and not yet run the app, which is every first-time user.`,
            );
        } else if (registered.includes(installed.installLocation)) {
            harness.pass(`${SCHEME}:// resolves to the installed app: ${registered}`);
        } else {
            harness.fail(`${SCHEME}:// resolves somewhere else: ${registered}`, `Expected a command under ${installed.installLocation}.`);
        }

        // 4. deep link, app not running (checked before any launch, so this is the installer's own registration, not
        //    the app's).
        harness.section(`deep link, app not running`);
        await openLink(SETUP_LINK);
        if (
            await harness.untilTrue(LINK_SECONDS, `the link started the app, which asked before running it`, () =>
                appWindowTitled(app, CONFIRM_TITLE),
            )
        ) {
            answer(harness, await answerConfirm(app, CONFIRM_TITLE));
            if (!(await harness.untilTrue(SCREEN_SECONDS, `answering it landed on the setup screen`, () => appWindowTitled(app, SETUP_TITLE)))) {
                harness.detail(await describeWindows());
            }
            await harness.untilTrue(10, `the setup ran only the local CLI stand-in`, () => hermetic.setupStarted());
        } else {
            harness.detail(await describeWindows());
        }
        await quitApp(executable);
        await harness.untilTrue(20, `the app closed`, async () => (await appWindows(app)).length === 0);

        // 5. launch
        harness.section(`launch`);
        const launch = await launchApp(executable);
        if (launch.code !== 0) {
            harness.fail(`could not start the app`, `${launch.stdout}${launch.stderr}`);
            return;
        }
        if (!(await harness.untilTrue(WINDOW_SETTLE_SECONDS, `the workspace window opened`, () => appWindowTitled(app, WORKSPACE_TITLE)))) {
            harness.detail(
                `The app's window never appeared. On this machine WebView2 was ${runtimeBefore ?? `absent before the install`}; a window that never maps with no runtime present is the runtime, not the app.`,
            );
            harness.detail(await describeWindows());
        }
        if (hermetic.workspaceInspectable) {
            await harness.untilTrue(30, `the workspace WebView loaded the local stub`, () => hermetic.workspaceRequested());
        }
        if (await appRunning(executable)) {
            harness.pass(`the process survived startup`);
        } else {
            harness.fail(`the process exited during startup`, `Workspace origin was ${hermetic.appUrl}.`);
        }

        // 6. deep link, app running (the OS handler, exercising registration and the single-instance forward together).
        harness.section(`deep link, app running`);
        await openLink(SETUP_LINK);
        if (
            await harness.untilTrue(LINK_SECONDS, `the link reached the running app, which asked before running it`, () =>
                appWindowTitled(app, CONFIRM_TITLE),
            )
        ) {
            answer(harness, await answerConfirm(app, CONFIRM_TITLE));
            if (!(await harness.untilTrue(SCREEN_SECONDS, `answering it opened the setup screen`, () => appWindowTitled(app, SETUP_TITLE)))) {
                harness.detail(await describeWindows());
            }
        } else {
            harness.detail(await describeWindows());
        }

        // One window in the workspace's place, not a second one beside it: the actual regression, invisible to every
        // other assertion here. Counted, not measured (a rectangle match could still pass with an extra window mapped).
        const visibleFaces = async (): Promise<WindowInfo[]> => (await appWindows(app)).filter((window) => window.title !== SINGLE_INSTANCE_WINDOW);
        const oneWindowShowingSetup = async (): Promise<boolean> => {
            const own = await visibleFaces();
            return own.length === 1 && own[0]!.title.includes(SETUP_TITLE);
        };
        if (!(await harness.untilTrue(15, `the setup screen took the workspace's window rather than opening a second one`, oneWindowShowingSetup))) {
            // Own windows listed first: two of the app's own and one that isn't the setup screen are different
            // failures.
            const own = await visibleFaces();
            harness.detail(own.length === 0 ? `the app showed no window` : own.map((window) => `- ${box(window)}`).join(`\n`));
            harness.detail(await describeWindows());
        }

        if (await appRunning(executable)) {
            harness.pass(`the original instance handled the link and is still running`);
        } else {
            harness.fail(`the original instance died while handling the link`);
        }

        // 7. uninstall
        if (options.keepInstalled) {
            harness.section(`left installed for the setup tier`);
            harness.pass(`${executable} stays on the machine`);
            return;
        }

        // Deliberately not quit first: the app running is the ordinary state the pre-uninstall hook exists for.
        harness.section(`uninstall, with the app running`);
        const uninstall = await uninstallSilently(installed.uninstallString);
        if (uninstall.code === 0) {
            harness.pass(`the uninstaller completed unattended, without a prompt`);
        } else {
            harness.fail(`the uninstaller exited ${uninstall.code}`, `${uninstall.stdout}${uninstall.stderr}`);
        }
        await harness.untilTrue(60, `Windows no longer lists it`, async () => (await findInstalledApp(PRODUCT_NAME)) === undefined);
        await harness.untilTrue(30, `no process is left running`, async () => !(await appRunning(executable)));
    } finally {
        await hermetic.close();
    }
};
