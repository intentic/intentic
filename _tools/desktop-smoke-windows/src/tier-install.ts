/* TIER 1, does the artifact we are about to ship INSTALL, LAUNCH, and answer a deep link, on Windows?
 *
 * The direct counterpart of `_tools/desktop-smoke/smoke.sh`, in the same order a user meets the same things,
 * and it exists because the Windows installer is the one artifact in this repo that is cross-built on a Linux
 * runner and then executed for the first time on a customer's PC. Until this tier ran, the only automated look
 * inside the installer was `verify-desktop-bundle.sh` unpacking it with 7z, which proves the files are
 * in the archive and nothing at all about what happens when someone double-clicks it.
 *
 * NO DOCKER OR CREDENTIALS. The app and setup are pointed at loopback stand-ins; only the installer's own
 * WebView2 bootstrap may need the network. That is what makes this the tier that can gate every release.
 *
 * The four things no `cargo test` can tell you, and one Windows adds:
 *
 *   1. INSTALL. The NSIS installer runs to completion, unattended, on a machine where the app is not present,
 *      and Windows lists it afterwards. On a host with no WebView2 runtime this is also where the installer's
 *      bootstrapper has to fetch one, which is the step that makes a Server-based runner differ from a desktop.
 *   2. ON DISK. The executable, and the bundled `scripts/` the app spawns. Those scripts ARE the app's entire
 *      native capability; a launcher button whose script is missing fails only when a user presses it.
 *   3. REGISTRATION. `intentic://` resolves to a command, asserted BEFORE the app has ever run, because that
 *      is the one moment the INSTALLER's registration is what answers. The app rewrites it on first start, so
 *      every assertion made after a single launch tests the app's own handler and none of them tests the
 *      shipped one. That is exactly how a package that registers the scheme and then drops every link it wins
 *      can sit in a release: correct in the archive, correct once the app has run, dead for the user who just
 *      installed it and clicked "set up".
 *   4. THE DEEP LINK, TWICE. A link finds the app in one of two states and they share almost no mechanism.
 *      NOT RUNNING: the OS starts the app WITH the link in argv and the app has to notice it at startup, the
 *      first-time user's path, and the half that was broken on Linux while the other half passed on every
 *      build. RUNNING: the OS starts a second copy whose argv the single-instance plugin forwards to the first.
 *   5. UNINSTALL. Windows-only, and worth asserting because the app is MEANT to be running when it happens,
 *      it lives in the tray once its window is closed, and the installer carries a pre-uninstall hook whose
 *      whole job is to end it so the built-in check never raises a message box at someone who already told the
 *      machine to remove it. An uninstall that leaves the app running is a dialog nobody is there to answer.
 *
 * Assertions read WINDOWS, not a test hook, the app has none and should not grow one. The window appearing IS
 * the behaviour a user is promised. Which windows are the app's is decided by the PROGRAM that owns them, and
 * the title only ever says which of its two screens is up: the app shows one window and swaps screens through
 * it. Those are separate questions, and answering both with the title is how another program's window, a
 * browser reading the product's own docs is titled `Intentic …`, gets counted as the app's. See `appWindows`.
 */

import type { WindowInfo } from "@intentic/desktop";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { appExecutable, appRunning, installSilently, launchApp, quitApp, uninstallSilently } from "./app.js";
import { APP_IDENTIFIER, CONFIRM_TITLE, PRODUCT_NAME, SCHEME, SETUP_LINK, SETUP_TITLE, WORKSPACE_TITLE } from "./constants.js";
import type { Harness } from "./harness.js";
import { prepareHermeticDesktop } from "./hermetic.js";
import { answerConfirm, appWindowTitled, appWindows, findInstalledApp, openLink, schemeCommand, webView2, windowTitles } from "./probe.js";

export interface InstallTierOptions {
    /** The `Intentic-<version>-x64-setup.exe` under test. */
    readonly installer: string;
    /** When this is a release gate, the version Windows must read back from the installed candidate. */
    readonly expectedVersion: string | undefined;
    /** Where the app's workspace window should point. A stub origin keeps this tier hermetic. */
    readonly appUrl: string | undefined;
    /** Leave the app installed when the tier finishes, what tier 2 needs, since it runs the INSTALLED scripts. */
    readonly keepInstalled: boolean;
}

const WINDOW_SETTLE_SECONDS = 60;
const LINK_SECONDS = 45;
const SCREEN_SECONDS = 30;

/* The single-instance plugin's own window, which the app owns for its whole life and nobody ever sees: 15×15
 * pixels at the origin, kept mapped because handing a second launch's argv to the first is a window message.
 * Tauri names it after the bundle identifier, so this is derived rather than written down twice.
 *
 * It has to be named because the one-window rule counts the app's windows BY OWNING PROGRAM, and by that
 * measure a perfectly ordinary app is always showing two. What the rule means is windows a person can see. */
const SINGLE_INSTANCE_WINDOW = `${APP_IDENTIFIER}-siw`;

/** One window's rectangle as a string, so two of them can be compared (and printed) as one value. */
const box = (window: WindowInfo): string => `${window.bounds.x},${window.bounds.y} ${window.bounds.width}×${window.bounds.height}`;

/** Its centre, what "this window is about that one" is asserted on, two windows of different sizes having no
 * corner in common. */
const middle = (window: WindowInfo): { x: number; y: number } => ({
    x: window.bounds.x + window.bounds.width / 2,
    y: window.bounds.y + window.bounds.height / 2,
});

const describeWindows = async (): Promise<string> => {
    const titles = await windowTitles();
    return titles.length === 0 ? `(no windows)` : titles.map((title) => `- ${title}`).join(`\n`);
};

/* Recorded only when it went wrong, because "a key was pressed" is not a promise made to anyone, every line
 * in this tier is something a user would see. What it prevents is the failure that reads as somebody else's:
 * a Return that never reached the dialog leaves the assertions below waiting out their deadlines, and their
 * wording ("the setup screen", "one window, not two") points at the app for a machine's refusal. */
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
        // Recorded, never asserted. A machine with no runtime is a legitimate machine, the installer is configured
        // to fetch one, but it changes what a launch failure means, and a log that does not say which kind of
        // machine this was cannot tell those two apart afterwards.
        const runtimeBefore = await webView2();
        harness.section(`the machine, before`);
        harness.pass(`WebView2 runtime: ${runtimeBefore ?? `absent, the installer's bootstrapper has to fetch one`}`);

        const already = await findInstalledApp(PRODUCT_NAME);
        if (already !== undefined) {
            // Not a failure to recover from: this tier's subject is a FIRST install, and an install over an existing
            // one is a different code path with different assertions. Saying so is the useful thing, a runner whose
            // snapshot did not reset is the likeliest cause, and it would otherwise show up as a puzzling pass.
            harness.fail(
                `${PRODUCT_NAME} ${already.version ?? ``} is already installed at ${already.installLocation}`,
                `This tier asserts a FIRST install on a clean machine. Reset the runner's snapshot, or uninstall by hand:\n  ${already.uninstallString} /S`,
            );
            return;
        }

        // ── 1. install ────────────────────────────────────────────────────────────────────────────────────────
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

        // ── 2. what the install put on disk ──────────────────────────────────────────────────────────────────
        harness.section(`on disk`);
        const executable = await appExecutable(installed.installLocation);
        if (executable === undefined) {
            harness.fail(`no executable in ${installed.installLocation}`);
            return;
        }
        harness.pass(`executable at ${executable}`);
        // How every window assertion below finds the app's OWN windows, see `appWindows` for why not by title.
        // Windows names a process after its executable's base name, so this is that name and nothing to keep in
        // step by hand.
        const app = basename(executable, `.exe`);

        // The bundled scripts, which the bundle config copies out of the site's public tree. `verify-desktop-bundle.sh`
        // proves the bundled BYTES match the source; this proves the install actually put them on the machine.
        const scripts = join(installed.installLocation, `scripts`);
        const shipped = [`connect.ps1`, `recreate.ps1`, `cleanup.ps1`];
        const missing = shipped.filter((script) => !existsSync(join(scripts, script)));
        if (missing.length === 0) {
            harness.pass(`bundled scripts installed at ${scripts}`);
        } else {
            harness.fail(`the bundled scripts are not on disk after install: ${missing.join(`, `)}`);
        }

        // ── 3. the registration a FRESH INSTALL has, before the app has ever run ─────────────────────────────
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

        // ── 4. the deep link a fresh install gets, with the app NOT running ──────────────────────────────────
        // FIRST, and before any launch, for the reason section 3 states: one launch and it is the app's own
        // registration under test rather than the installer's.
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

        // ── 5. launch ────────────────────────────────────────────────────────────────────────────────────────
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

        // ── 6. the deep link, into the app that is already running ───────────────────────────────────────────
        // Through the OS handler, not by calling the executable with an argument: this is the route a link takes
        // from an external browser, and it exercises the registration and the single-instance forward together.
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

        /* …IN FRONT OF the workspace, and much smaller than it. The whole window model as one assertion, and
         * worth one because the failure it guards is invisible to every other assertion here: a setup screen
         * that opens as a second full-size window somewhere else satisfies the search above perfectly well,
         * and what the user gets is an unasked-for window beside the one they were reading.
         *
         * This was asserted as "the same rectangle" while setup was a chromeless sheet on the workspace's own
         * frame. That is the shape it replaced, and this platform is where it was worst: a first install comes
         * from a link in the browser with no workspace open, so the sheet came up at the app's default
         * 1440×900, which at Windows' usual 150% scaling is 2160×1350 physical, over every other window, with
         * no title bar to move it by and no button to minimise it. What is asserted now is what makes it
         * usable: a dialog-sized window, centred on the app it is about. Taken after the search, so the move
         * has landed. */
        const faces = async (): Promise<{ setup?: WindowInfo; workspace?: WindowInfo }> => {
            const own = (await appWindows(app)).filter((window) => window.title !== SINGLE_INSTANCE_WINDOW);
            const setup = own.find((window) => window.title.includes(SETUP_TITLE));
            // Everything that is not the setup screen is the workspace: this app has exactly two faces, and
            // the manager's is not up while a setup is.
            const workspace = own.find((window) => !window.title.includes(SETUP_TITLE));
            return { ...(setup && { setup }), ...(workspace && { workspace }) };
        };
        const dialogOverWorkspace = async (): Promise<boolean> => {
            const { setup, workspace } = await faces();
            if (setup === undefined || workspace === undefined) {
                return false;
            }
            // Smaller in both directions by a real margin, the workspace opens at 1440×900 and this at
            // 620×640, so anything near the workspace's own width is the sheet coming back. And centred on it,
            // which is what says the window is ABOUT the app rather than merely near it; a whole setup
            // window's slack each way, so the desktop's own placement nudge is not a failure.
            const smaller = setup.bounds.width < workspace.bounds.width * 0.75 && setup.bounds.height < workspace.bounds.height;
            const [own, behind] = [middle(setup), middle(workspace)];
            return smaller && Math.abs(own.x - behind.x) <= setup.bounds.width && Math.abs(own.y - behind.y) <= setup.bounds.height;
        };
        if (
            !(await harness.untilTrue(
                15,
                `the setup screen is a dialog-sized window centred on the workspace, not a sheet over the screen`,
                dialogOverWorkspace,
            ))
        ) {
            /* The two rectangles FIRST, because they are the whole of what this assertion compared and a list
             * of titles cannot say which way it went wrong. A missing one reads as a window that never came;
             * a setup one the size of the workspace reads as the sheet, which is the failure this assertion
             * exists for and the one the Linux tier prints geometry for. */
            const { setup, workspace } = await faces();
            harness.detail(`setup:     ${setup ? box(setup) : `(no such window)`}\nworkspace: ${workspace ? box(workspace) : `(no such window)`}`);
            harness.detail(await describeWindows());
        }

        if (await appRunning(executable)) {
            harness.pass(`the original instance handled the link and is still running`);
        } else {
            harness.fail(`the original instance died while handling the link`);
        }

        // ── 7. uninstall ─────────────────────────────────────────────────────────────────────────────────────
        if (options.keepInstalled) {
            harness.section(`left installed for the setup tier`);
            harness.pass(`${executable} stays on the machine`);
            return;
        }

        // Deliberately WITHOUT quitting first: the app running is the ordinary state at uninstall time, and the
        // pre-uninstall hook exists precisely for it.
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
