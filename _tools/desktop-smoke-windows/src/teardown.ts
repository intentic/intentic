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

import { LOCAL_PORT } from "@intentic/constants";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { uninstallSilently } from "./app.js";
import { CONNECT_TOKEN, PRODUCT_NAME, SANDBOX_HOSTNAME } from "./constants.js";
import type { Harness } from "./harness.js";
import { sandboxContainerName, SANDBOX_CONTAINER_PREFIX } from "./parse.js";
import { containersPublishing, findInstalledApp, removeContainer } from "./probe.js";
import { powershell } from "./run.js";

/* A SANDBOX OF THIS TIER'S UNDER SOME OTHER NAME, which is the one leftover removing today's container cannot
 * reach, and the one that breaks tier 3 permanently rather than once.
 *
 * The loopback port a browser dials is derived from the sandbox id, which is derived from the connect token —
 * and this tier's connect token is a CONSTANT (constants.ts). So every sandbox it has ever created, under every
 * hostname the tier has been written with, wants the same host port. Docker refuses a whole `docker run` whose
 * `-p` is taken, and `ic` answers that by retrying WITHOUT the shortcut (sandbox/connect.rs) rather than failing
 * the setup: the new sandbox comes up healthy and publishes nothing, while the older container keeps answering
 * on the port tier 3 derives. Everything up to the credential then passes against the wrong daemon, because a
 * stranger's sandbox is also reachable and also correctly gated.
 *
 * `--restart unless-stopped` is on every sandbox, so such a container outlives reboots and every later run.
 * Scoped to this product's own containers by name: whatever else holds that port is not something a test tier
 * may remove, and tier 3 names it instead. */
const removeSquatters = async (harness: Harness, keep: string): Promise<void> => {
    const sandboxId = sandboxIdFromToken(CONNECT_TOKEN);
    if (sandboxId === undefined) {
        return;
    }
    const port = localDaemonPort(sandboxId);
    for (const name of await containersPublishing(port)) {
        if (name === keep || !name.startsWith(SANDBOX_CONTAINER_PREFIX)) {
            continue;
        }
        await removeContainer(name);
        harness.pass(`${name} no longer holds this tier's loopback port (${port} → ${LOCAL_PORT})`);
    }
};

export const runTeardown = async (harness: Harness): Promise<void> => {
    harness.section(`putting the machine back`);

    const container = sandboxContainerName(SANDBOX_HOSTNAME);
    await removeContainer(container);
    harness.pass(`${container} is gone`);
    await removeSquatters(harness, container);

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
