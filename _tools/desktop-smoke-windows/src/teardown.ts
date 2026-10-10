// Puts the machine back for the next run — the app uninstalled, the container gone, the keyboard reachable; a
// snapshot-reset runner doesn't need this, everything else does. Never fails the job: nothing here is news, since the
// app not being installed or the container not existing are the states this is trying to reach.

import { LOCAL_PORT } from "@intentic/constants";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { uninstallSilently } from "./app.js";
import { CONNECT_TOKEN, PRODUCT_NAME, SANDBOX_HOSTNAME } from "./constants.js";
import { ENGINE_DISTRO, ENGINE_RUN_VALUE, ENGINE_SANDBOX_HOSTNAME } from "./engine.js";
import type { Harness } from "./harness.js";
import { lockScreenHolds, sandboxContainerName, SANDBOX_CONTAINER_PREFIX } from "./parse.js";
import { containersPublishing, dismissLockScreen, findInstalledApp, removeContainer, sessionState } from "./probe.js";
import { powershell, run } from "./run.js";
import { ENGINE_ROOT } from "./tier-engine.js";

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

/* WHAT THE ENGINE TIER LEAVES when it is cut short: its distro, the bridge and rules its dockerd put into WSL's shared
network (which every distro on this machine, the Linux fleet's included, would otherwise keep until WSL restarts), its
Run key value, its isolated home, and its sandbox on Docker Desktop. Each step may find nothing. */
const removeEngine = async (harness: Harness): Promise<void> => {
    const listed = await run(`wsl.exe`, [`--list`, `--quiet`], { env: { WSL_UTF8: `1` }, timeoutMs: 30_000 });
    if (listed.stdout.replace(/\0/g, ``).split(/\r?\n/).some((name) => name.trim() === ENGINE_DISTRO)) {
        let teardown = ``;
        try {
            teardown = readFileSync(new URL(`../../../_sandbox/ic/engine/rootfs/teardown`, import.meta.url), `utf8`);
        } catch {
            // Without the script the distro still goes; its rules go when WSL next restarts.
        }
        if (teardown !== ``) {
            await run(`wsl.exe`, [`-d`, ENGINE_DISTRO, `-u`, `root`, `--exec`, `sh`, `-c`, teardown], { timeoutMs: 60_000 });
        }
        await run(`wsl.exe`, [`--unregister`, ENGINE_DISTRO], { timeoutMs: 120_000 });
        harness.pass(`the engine tier's distro (${ENGINE_DISTRO}) and what it put into WSL's network are gone`);
    }
    await run(`reg.exe`, [`delete`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, `/v`, ENGINE_RUN_VALUE, `/f`], { timeoutMs: 15_000 });
    rmSync(ENGINE_ROOT, { recursive: true, force: true });
    const sandbox = sandboxContainerName(ENGINE_SANDBOX_HOSTNAME);
    const slug = sandbox.slice(SANDBOX_CONTAINER_PREFIX.length);
    for (const name of [sandbox, `${sandbox}.moved`]) {
        await removeContainer(name);
    }
    await run(`docker`, [`volume`, `rm`, `-f`, `intentic-workspace-${slug}`, `intentic-history-${slug}`, `intentic-docker-${slug}`]);
    // ic names a sandbox's network as its workspace volume (ic's sandbox/trash.rs `network`).
    await run(`docker`, [`network`, `rm`, `intentic-workspace-${slug}`]);
};

export const runTeardown = async (harness: Harness): Promise<void> => {
    harness.section(`putting the machine back`);
    await clearLockScreen(harness);
    await removeEngine(harness);

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
