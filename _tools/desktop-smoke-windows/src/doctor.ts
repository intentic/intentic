/* Is this machine able to answer the question the tiers ask?
 *
 * Every line here exists because its absence produces a FAILURE THAT NAMES THE WRONG THING. A runner installed
 * as a service maps no windows, and reads as "the app never started". A Docker in Windows-container mode
 * answers every probe and then fails an image pull. A machine with the app already installed passes an install
 * tier that installed nothing. None of those are product bugs and all of them look like one.
 *
 * So this runs FIRST, on its own, and reports the machine rather than the product. On a new box it is the
 * cheapest possible first move: seconds, no artifacts, no Docker pulls, and its output is the setup checklist
 * with the boxes already ticked.
 *
 * It reports; it does not fix. A doctor that installed Docker or killed a stray app would be making the machine
 * pass rather than telling you what it is, and on a snapshot-reset runner the honest answer to "the app is
 * already installed" is that the snapshot did not reset, which no amount of uninstalling addresses.
 */

import { PRODUCT_NAME, RUNNER_TASK_NAME, SCHEME } from "./constants.js";
import type { Harness } from "./harness.js";
import { humanDuration, runnerSupervision } from "./parse.js";
import { dockerContainerOs, dockerReachable, findInstalledApp, runnerTask, schemeCommand, userInteractive, webView2, windows } from "./probe.js";

export interface DoctorOptions {
    /** Whether Docker is needed, tier 1 does not need it, tiers 2 and 3 do. */
    readonly needsDocker: boolean;
}

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

    /* WILL THIS RUNNER STILL BE HERE TOMORROW. Not an assertion either, and deliberately: a runner somebody
     * started in a console window has a desktop and passes everything below it, so failing the run would be
     * this tier objecting to something that is about the NEXT reboot rather than about this build. But it is
     * the state that takes the Windows leg of the pipeline down for a day at a time, with jobs queueing against
     * a label nothing answers and no failure anywhere to read, so it is said out loud in the log of a run that
     * passed — which is the only place anyone asking "why did CI stop?" will find it. */
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

    // Not an assertion: a machine with no windows open is normal, and this is here so the log says what the
    // desktop looked like when something later could not find a window on it.
    const open = await windows();
    harness.pass(`${open.length} window(s) currently open`);

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
