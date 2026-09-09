// Whether this machine can answer what the tiers ask, checked first so a bad symptom names the machine and not the
// product (a runner-as-service maps no windows; a locked desktop refuses every keystroke; a Windows container answers
// every Docker probe). Reports only, never fixes: installing or killing something would mask a snapshot that didn't
// reset. What CAN be reconciled is teardown's job, and the workflow runs it first for that reason.

import { errorMessage } from "@intentic/base/errors";
import type { SessionState } from "@intentic/desktop-automation";
import { PRODUCT_NAME, RUNNER_TASK_NAME, SCHEME } from "./constants.js";
import type { Harness } from "./harness.js";
import { desktopReadiness, humanDuration, runnerSupervision } from "./parse.js";
import {
    dockerContainerOs,
    dockerReachable,
    findInstalledApp,
    runnerTask,
    schemeCommand,
    sessionState,
    userInteractive,
    webView2,
    windows,
} from "./probe.js";

export interface DoctorOptions {
    /** Whether Docker is needed; tier 1 doesn't, tiers 2 and 3 do. */
    readonly needsDocker: boolean;
}

/*
 * AN ASSERTION, NOT A NOTE, and the only check here that was once written as one.
 *
 * An empty desktop is normal and so is a busy one — this box has Docker Desktop and PowerToys resident on every
 * run — so the count was recorded and nothing was asserted. What a count cannot say is who holds the
 * FOREGROUND, and that is the one machine state that makes the tiers' `focusWindow` fail with nothing wrong
 * with the product. The line used to look for the holder in the window list, which is the one place a lock
 * screen is not: it printed "9 window(s) currently open, none holding the foreground", called the machine
 * ready, and a release then failed six assertions that all read as a broken deep link.
 *
 * The read is the OS's now (`sessionState`), and a desktop no tier could drive fails HERE, with its own remedy,
 * ten seconds in — which is the whole reason this command exists.
 */
const reportDesktop = async (harness: Harness): Promise<void> => {
    let session: SessionState;
    try {
        session = await sessionState();
    } catch (error) {
        // A machine that cannot answer this is not a machine to run the tiers on: every one of them types.
        harness.fail(`this desktop's foreground could not be read`, errorMessage(error));
        return;
    }
    const verdict = desktopReadiness(await windows(), session);
    if (verdict.drivable) {
        harness.pass(verdict.summary);
        return;
    }
    harness.fail(verdict.summary, verdict.remedy);
};

export const runDoctor = async (harness: Harness, options: DoctorOptions): Promise<void> => {
    harness.section(`the session`);
    if (process.platform !== `win32`) {
        harness.fail(`this is ${process.platform}, not Windows`, `These tiers exist to run the Windows artifact on Windows.`);
        return;
    }
    harness.pass(`Windows`);

    if (await userInteractive()) {
        harness.pass(`the process has an interactive desktop`);
    } else {
        harness.fail(
            `no interactive desktop (session 0)`,
            `The app has a window and a tray icon, and every assertion reads window titles: none of which exist in a service session.\n` +
                `The runner is installed as a Windows service. It has to run in a logged-in user session instead, which is a\n` +
                `property of how it was REGISTERED: the one thing about this machine a job cannot repair from inside itself,\n` +
                `since the job IS the runner. From an elevated PowerShell on the runner:\n` +
                `  _tools/scripts/ci/setup-windows-runner.ps1 -Repair`,
        );
    }

    // Not an assertion: this is about the next reboot, not this build, but it's the only state that takes CI down for a
    // day with nothing to read, so it's logged even on a passing run.
    const supervision = runnerSupervision(await runnerTask(RUNNER_TASK_NAME));
    if (supervision.kind === `supervised`) {
        harness.pass(`the runner is the logon task's, re-checked every ${humanDuration(supervision.repetition)}`);
    } else if (supervision.kind === `no-watchdog`) {
        harness.pass(
            `the runner is the logon task's, but nothing re-checks it: it comes back at the next sign-in and not before. ` +
                `_tools/scripts/ci/setup-windows-runner.ps1 -Repair adds the watchdog`,
        );
    } else {
        harness.pass(
            `THE RUNNER WAS STARTED BY HAND, not by the logon task: it dies with that console window, with the sign-out and ` +
                `with the reboot, and nothing brings it back. This run is fine; the next one may find no runner at all. ` +
                `_tools/scripts/ci/setup-windows-runner.ps1 -Repair makes it unattended`,
        );
    }

    await reportDesktop(harness);

    harness.section(`the runtime the app draws with`);
    const runtime = await webView2();
    if (runtime === undefined) {
        harness.pass(`WebView2 is absent: the installer's bootstrapper will fetch it (slower first run; Windows Server's usual state)`);
    } else {
        harness.pass(`WebView2 ${runtime}`);
    }

    harness.section(`a clean machine`);
    const installed = await findInstalledApp(PRODUCT_NAME);
    if (installed === undefined) {
        harness.pass(`${PRODUCT_NAME} is not installed`);
    } else {
        harness.fail(
            `${PRODUCT_NAME} ${installed.version ?? ``} is already installed at ${installed.installLocation}`,
            `The install tier's subject is a FIRST install. Reset the runner's snapshot before the run.`,
        );
    }

    const registered = await schemeCommand(SCHEME);
    if (registered === undefined) {
        harness.pass(`nothing yet claims ${SCHEME}://`);
    } else {
        harness.fail(
            `${SCHEME}:// is already registered to ${registered}`,
            `A leftover registration would satisfy the install tier's own assertion.`,
        );
    }

    if (!options.needsDocker) {
        return;
    }

    harness.section(`docker`);
    if (!(await dockerReachable())) {
        harness.fail(
            `no Docker daemon answers`,
            `Docker Desktop must be installed, started and signed in before the setup tier. After a snapshot reset it can take a minute past login.`,
        );
        return;
    }
    harness.pass(`a Docker daemon answers`);

    const containerOs = await dockerContainerOs();
    if (containerOs === `linux`) {
        harness.pass(`it runs linux containers`);
        return;
    }
    harness.fail(
        `it runs ${containerOs ?? `unknown`} containers, not linux`,
        `A sandbox is a Linux container. This is the DEFAULT state of the Docker preinstalled on Windows CI images, and it is\n` +
            `invisible to every check the shipped scripts make: they see a daemon answering and go on to pull a Linux image.\n` +
            `Switch Docker Desktop to Linux containers, or start it with the WSL2 backend.`,
    );
};
