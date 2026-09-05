import { join } from "node:path";
import { z } from "zod";
import { enrollments, pairings } from "../store/enrollment.js";

/* The credential half of a RUNNER, this sandbox's own execution container on another machine (runner-hub.ts
 * is the live half; docs/remote-runners-plan.md, workspace root, is the design). The shared mechanic
 * (store/enrollment.ts) with the hosts door's two pairing sources collapsed to one: the parent mints, `ic
 * runner up` (or the Fly provisioner) carries the token into the runner's container env, and the runner
 * redeems it exactly once over /system/runners/enroll for the durable token its every reconnect presents.
 *
 * EVERY pairing here is minted replayable, which is what used to read as a stricter rule than the hosts
 * store's and is the same rule meeting a different population: a runner's pairing ALWAYS ends up in a
 * container's environment, immortal by comparison with this daemon (visible in `docker inspect`, replayed
 * verbatim into every rebuilt container), so the moment one works its digest is burned and the env copy is
 * inert from then on.
 *
 * On /history for the hosts store's reason inverted: this token is not a key to somebody's laptop, but it IS
 * what lets a socket claim to be the container this sandbox dispatches work and provider credentials to, so
 * it sits where no tool the agent has can read it, as digests even there. */

export interface RunnerRecord {
    readonly id: string;
    readonly host?: string | undefined;
}

export interface RunnersStore {
    // Bind a pairing to one runner id. Single-use, expiring; the raw token is handed to the provisioner once.
    // `host` is the device being asked to create it, carried onto the enrollment when the pairing is spent.
    readonly mintPairing: (id: string, host?: string) => { token: string; expiresIn: number };
    // Redeem a pairing: the runner gets its durable token, the pairing is spent and burned whether or not the
    // runner ever connects. Undefined ⇒ unknown, expired, or replayed, which the route answers as 401.
    readonly enroll: (pairToken: string) => Promise<{ id: string; runnerToken: string } | undefined>;
    // Which runner is presenting this token, or undefined. The only authorization on the WebSocket.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    readonly list: () => Promise<RunnerRecord[]>;
    // Drop a runner's enrollment; its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const runnerEnrollmentsPath = (historyRoot: string): string => join(historyRoot, "runner-enrollments.json");

// The pairings that have been redeemed, as digests: this file records that something was spent, and needs to
// hold nothing that could spend anything.
export const runnerPairBurnPath = (historyRoot: string): string => join(historyRoot, "runner-pair-consumed.json");

export const fileRunnersStore = (historyRoot: string): RunnersStore => {
    const pending = pairings<RunnerRecord>(runnerPairBurnPath(historyRoot));
    /* WHICH CONNECTED DEVICE HOLDS IT, when this sandbox is the one that asked for it (the Devices view's
     * create flow, hosts/device-reports.ts). It is the only way back to the machine that can stop or remove
     * this container, and the runner itself cannot supply it: from inside, a container knows its own hostname
     * and nothing about the capability its host is filed under. Absent for a runner somebody started by hand
     * with `ic runner up`, which is not a lesser runner, only one this sandbox cannot offer machine buttons
     * for — so it rides the PAIRING, which is the last point at which anyone still knows. */
    const records = enrollments({
        path: runnerEnrollmentsPath(historyRoot),
        key: "runners",
        prefix: "irt_",
        extra: { host: z.string().optional() },
    });

    return {
        mintPairing: (id, host) => pending.mint({ id, ...(host === undefined ? {} : { host }) }, { replayable: true }),
        enroll: async (pairToken) => {
            const pairing = await pending.redeem(pairToken);
            if (pairing === undefined) {
                return undefined;
            }
            const runnerToken = await records.issue(pairing.id, pairing.host === undefined ? {} : { host: pairing.host });
            return { id: pairing.id, runnerToken };
        },
        verify: records.verify,
        enrolled: records.enrolled,
        list: records.list,
        revoke: records.revoke,
    };
};
