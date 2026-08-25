import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { jsonFile } from "../store/json-file.js";

/* The credential half of a RUNNER, this sandbox's own execution container on another machine (runner-hub.ts
 * is the live half; docs/remote-runners-plan.md, workspace root, is the design). The hosts-store pattern
 * narrowed: the parent mints a single-use pairing, `ic runner up` (or the Fly provisioner) carries it into
 * the runner's container env, and the runner redeems it exactly once over /system/runners/enroll for the
 * durable token its every reconnect presents.
 *
 * EVERY redeemed pairing is burned on /history, not only seeded ones, which is simpler than the hosts store's
 * split and strictly as safe: a runner's pairing always lives in a container's environment, immortal by
 * comparison with the daemon (visible in `docker inspect`, replayed verbatim into every rebuilt container),
 * so the moment it works the digest is recorded and the env copy is inert.
 *
 * On /history for the hosts store's reason inverted: this token is not a key to somebody's laptop, but it IS
 * what lets a socket claim to be the container this sandbox dispatches work and provider credentials to, so
 * it sits where no tool the agent has can read it, as digests even there. */

const StoredRunnersSchema = z.object({
    runners: z.array(
        z.object({
            // The runner's id, one enrollment per runner, so a re-pair rotates.
            id: z.string(),
            hash: z.string(),
            enrolledAt: z.number(),
            /* WHICH CONNECTED COMPUTER HOLDS IT, when this sandbox is the one that asked for it (the Computers
             * view's create flow, hosts/machine-reports.ts). It is the only way back to the machine that can
             * stop or remove this container, and the runner itself cannot supply it: from inside, a container
             * knows its own hostname and nothing about the capability its host is filed under. Absent for a
             * runner somebody started by hand with `ic runner up`, which is not a lesser runner, only one this
             * sandbox cannot offer machine buttons for. */
            host: z.string().optional(),
        }),
    ),
});
type StoredRunners = z.infer<typeof StoredRunnersSchema>;

// Long enough for a container to be created and boot to its enroll call; short enough that a pairing left in
// a chat log is inert by the time anyone reads it. The hosts pairing's window, for the same reasons.
const PAIR_TTL_MS = 10 * 60 * 1000;

export interface RunnerRecord {
    readonly id: string;
    readonly host?: string | undefined;
}

export interface RunnersStore {
    // Bind a pairing to one runner id. Single-use, expiring; the raw token is handed to the provisioner once.
    // `host` is the computer being asked to create it, carried onto the enrollment when the pairing is spent.
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

const BurnedSchema = z.object({ digests: z.array(z.string()) });

export const fileRunnersStore = (historyRoot: string): RunnersStore => {
    const file = jsonFile<StoredRunners>(runnerEnrollmentsPath(historyRoot), {
        parse: (raw) => StoredRunnersSchema.safeParse(raw).data,
        fallback: () => ({ runners: [] }),
        mode: 0o600,
    });
    const burned = jsonFile<z.infer<typeof BurnedSchema>>(runnerPairBurnPath(historyRoot), {
        parse: (raw) => BurnedSchema.safeParse(raw).data,
        fallback: () => ({ digests: [] }),
        mode: 0o600,
    });
    // In memory, the hosts store's stance: a pairing outliving a daemon restart buys nothing (the flow that
    // wants one mints another) and would mean persisting a live credential to protect.
    const pairings = new Map<string, { id: string; host?: string; expiresAt: number }>();

    return {
        mintPairing: (id, host) => {
            const token = randomBytes(32).toString("base64url");
            pairings.set(token, { id, ...(host !== undefined ? { host } : {}), expiresAt: Date.now() + PAIR_TTL_MS });
            for (const [key, pairing] of pairings) {
                if (pairing.expiresAt < Date.now()) {
                    pairings.delete(key);
                }
            }
            return { token, expiresIn: Math.floor(PAIR_TTL_MS / 1000) };
        },
        enroll: async (pairToken) => {
            const pairing = pairings.get(pairToken);
            if (pairing === undefined || pairing.expiresAt < Date.now()) {
                pairings.delete(pairToken);
                return undefined;
            }
            const digest = sha256Hex(pairToken);
            if ((await burned.read()).digests.includes(digest)) {
                return undefined;
            }
            pairings.delete(pairToken);
            await burned.update((stored) => (stored.digests.includes(digest) ? stored : { digests: [...stored.digests, digest] }));
            const runnerToken = `irt_${randomBytes(32).toString("base64url")}`;
            const entry = { id: pairing.id, hash: sha256Hex(runnerToken), enrolledAt: Date.now(), ...(pairing.host !== undefined ? { host: pairing.host } : {}) };
            // Re-pairing a runner ROTATES it: the old token stops verifying the moment the new one lands.
            await file.update((stored) => ({ runners: [...stored.runners.filter((runner) => runner.id !== entry.id), entry] }));
            return { id: pairing.id, runnerToken };
        },
        verify: async (presented) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe whatever the presented token's length.
            return (await file.read()).runners.find((runner) => tokenEquals(runner.hash, hash))?.id;
        },
        enrolled: async (id) => (await file.read()).runners.some((runner) => runner.id === id),
        list: async () => (await file.read()).runners.map((runner) => ({ id: runner.id, ...(runner.host !== undefined ? { host: runner.host } : {}) })),
        revoke: async (id) => {
            let revoked = false;
            await file.update((stored) => {
                const next = stored.runners.filter((runner) => runner.id !== id);
                revoked = next.length !== stored.runners.length;
                return revoked ? { runners: next } : stored;
            });
            return revoked;
        },
    };
};
