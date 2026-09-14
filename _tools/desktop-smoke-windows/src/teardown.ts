// Puts the machine back for the next run — the app uninstalled, the container gone, the keyboard reachable; a
// snapshot-reset runner doesn't need this, everything else does. Never fails the job: nothing here is news, since the
// app not being installed or the container not existing are the states this is trying to reach.

import { LOCAL_PORT } from "@intentic/constants";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { setTimeout as delay } from "node:timers/promises";
import { uninstallSilently } from "./app.js";
import { CONNECT_TOKEN, PRODUCT_NAME, SANDBOX_HOSTNAME } from "./constants.js";
import type { Harness } from "./harness.js";
import { lockScreenHolds, sandboxContainerName, SANDBOX_CONTAINER_PREFIX } from "./parse.js";
import { containersPublishing, dismissLockScreen, findInstalledApp, removeContainer, sessionState } from "./probe.js";
import { powershell } from "./run.js";

// A stale sandbox under another name squats this tier's derived port (the connect token is a constant, so every run
// wants the same one) and answers in today's place, since ic retries without -p. Removed by container-name prefix only.
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

// How long the foreground takes to land on a real window after the lock screen's is destroyed. Polled rather
// than slept through, and short: this runs on every job, including the ones with no lock screen to clear.
const FOREGROUND_SETTLE_MS = 3_000;
const FOREGROUND_POLL_MS = 250;

/* THE ONE LEFTOVER THAT IS NOT A FILE OR A CONTAINER: a lock screen still holding the keyboard. */
const clearLockScreen = async (harness: Harness): Promise<void> => {
    const held = await sessionState().catch(() => undefined);
    if (held === undefined || !lockScreenHolds(held)) {
        return;
    }
    await dismissLockScreen();
    const deadline = Date.now() + FOREGROUND_SETTLE_MS;
    for (;;) {
        const now = await sessionState().catch(() => undefined);
        if (now !== undefined && !lockScreenHolds(now)) {
            harness.pass(`the lock screen no longer holds the foreground`);
            return;
        }
        if (Date.now() >= deadline) {
            // Never a failure: teardown's job is what it can reach, and the doctor is what refuses a machine.
            harness.pass(
                `the lock screen still holds the foreground${now?.locked === true ? `, and Windows is drawing its sign-in screen over this session` : ``} — ` +
                    `the doctor refuses this machine rather than letting the tiers read it as the app's fault`,
            );
            return;
        }
        await delay(FOREGROUND_POLL_MS);
    }
};

export const runTeardown = async (harness: Harness): Promise<void> => {
    harness.section(`putting the machine back`);
    await clearLockScreen(harness);

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
    // A failed uninstall leaves the registration, satisfying the install tier's own assertion on stale evidence.
    await powershell(
        `$ErrorActionPreference='SilentlyContinue'
         Remove-Item -Recurse -Force 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\intentic'`,
    );
    harness.pass(`${PRODUCT_NAME} uninstalled and its scheme registration cleared`);
};
