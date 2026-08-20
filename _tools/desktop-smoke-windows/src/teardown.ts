/* Putting the machine back, so the NEXT run meets a clean one.
 *
 * A snapshot-reset runner does not need this. Every other arrangement does, and the failure without it is
 * confusing rather than loud: the install tier's subject is a FIRST install, so a leftover from yesterday
 * makes today's run stop before it has installed anything, with a message about the snapshot that is only
 * correct on the machines that have one.
 *
 * It NEVER fails the job. A teardown that can go red gives a green run a way to turn red for something that
 * already worked, and there is nothing here whose failure is news: the app not being installed and the
 * container not existing are both the state this is trying to reach.
 */

import { uninstallSilently } from "./app.js";
import { PRODUCT_NAME, SANDBOX_HOSTNAME } from "./constants.js";
import type { Harness } from "./harness.js";
import { sandboxContainerName } from "./parse.js";
import { findInstalledApp, removeContainer } from "./probe.js";
import { powershell } from "./run.js";

export const runTeardown = async (harness: Harness): Promise<void> => {
    harness.section(`putting the machine back`);

    const container = sandboxContainerName(SANDBOX_HOSTNAME);
    await removeContainer(container);
    harness.pass(`${container} is gone`);

    const installed = await findInstalledApp(PRODUCT_NAME);
    if (installed === undefined) {
        harness.pass(`${PRODUCT_NAME} is not installed`);
        return;
    }
    await uninstallSilently(installed.uninstallString);
    // The registration outlives a failed uninstall, and a leftover one satisfies the install tier's own
    // "is the scheme registered" assertion, which would then be passing on yesterday's evidence.
    await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Remove-Item -Recurse -Force 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\intentic'`,
    );
    harness.pass(`${PRODUCT_NAME} uninstalled and its scheme registration cleared`);
};
