import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../../config.js";
import { getMachine, startMachine } from "./fly/fly.js";

// After a config replacement, a machine refuses starts (412) while `replacing`, and an update never starts one that was
// stopped. Wait for it to settle, then start, then confirm it ran.
const SETTLE_ATTEMPTS = 60;
const SETTLE_MS = 500;
/* WHAT COUNTS AS RUNNING HERE, and why `created` does not.
 *
 * Replacing a stopped machine's config builds it a new VM record, and that record reads `created` for about a second
 * before settling back to `stopped` — the machine has not been asked to run, and nothing is going to ask it. Counting
 * `created` as running made this loop return the moment it caught that second, so the claim committed the row, the
 * hand-off succeeded, and the owner was given a machine that had never been started. It is a race, so it only bit
 * whichever claims read fast: in the live fleet it was half of one day's claims, plus the platform's own canary, plus
 * one sandbox that sat un-started for seventeen days. A machine is running here when Fly says it is starting or
 * started, and a start is issued for every other reading that will accept one. */
const RUNNING_STATES = new Set([`starting`, `started`]);
export const startAfterUpdate = async (
    config: Config,
    hosted: { appName: string; machineId: string },
    assertActive?: () => Promise<void>,
): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- settling is sequential by definition
        const machine = await getMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error) => {
            lastError = error;
            return undefined;
        });
        // A read that answered supersedes an earlier failure: the cause named at the end is the latest one.
        if (machine !== undefined) {
            lastError = undefined;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- cancellation must stop the settling loop before another start
        await assertActive?.();
        if (machine !== undefined && RUNNING_STATES.has(machine.state)) {
            return;
        }
        // Still replacing (or unreadable): starting now would only earn the 412 above.
        if (machine !== undefined && machine.state !== `replacing`) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            await startMachine(config.hosted.flyApiToken, hosted.appName, hosted.machineId).catch((error) => {
                lastError = error;
            });
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        await delay(SETTLE_MS);
    }
    // Settled but still won't run: broken, not busy; the claim must fail rather than hand over a dead machine.
    throw new Error(
        `fly machine ${hosted.machineId} did not start after its config was replaced${lastError === undefined ? `` : `: ${String(lastError)}`}`,
        { cause: lastError },
    );
};
