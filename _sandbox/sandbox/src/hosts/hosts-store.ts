import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { jsonFile } from "../store/json-file.js";

/* The credential half of a `host` capability — the user's own computer, enrolled once and then holding a
 * long-lived socket to this daemon (hosts/host-hub.ts is the live half).
 *
 * The shape is the desktop-sync pairing (platform/sync.ts) narrowed to one machine: the owner mints a
 * single-use, short-lived pairing token in the browser, the one-liner carries it, and the @intentic/host agent
 * redeems it exactly once for a durable per-machine token. Nothing about the machine's identity is asserted by
 * the machine — the pairing already names WHICH capability it enrolls, so a redeemed token can only ever become
 * the computer the owner was looking at when they clicked Connect.
 *
 * WHERE THIS LIVES IS THE POINT. On /history, not /work/.intentic: this token is a key to somebody's actual
 * laptop, and /work is the one directory the agent reads and writes all day. The bridge-token store made the
 * opposite call for a credential scoped to the agent's own surface (a stolen bridge token ≈ the agent's reach);
 * here a leak is a shell on the owner's machine, so the file sits where no tool the agent has can open it, and
 * holds digests rather than tokens even there. It also means an enrollment survives the `docker rm -f` of a
 * rebuild, exactly like sync's — the machine keeps working instead of silently going dark until someone
 * re-pairs it. */

const StoredHostsSchema = z.object({
    hosts: z.array(
        z.object({
            // The capability id — the machine's name. One enrollment per machine, so a re-enroll rotates.
            id: z.string(),
            hash: z.string(),
            enrolledAt: z.number(),
        }),
    ),
});
type StoredHosts = z.infer<typeof StoredHostsSchema>;

// Long enough to walk to the machine, open a terminal and paste; short enough that a one-liner left in a chat
// log is inert by the time anyone reads it. The sync pairing's window, for the same reasons.
const PAIR_TTL_MS = 10 * 60 * 1000;

export interface HostsStore {
    // Bind a pairing to one capability id. Single-use, expiring; the raw token is shown once, in the browser.
    readonly mintPairing: (id: string) => { token: string; expiresIn: number };
    // Redeem a pairing: the machine gets its durable token, and the pairing is spent whether or not the machine
    // ever connects. Undefined ⇒ unknown or expired, which the route answers as 401.
    readonly enroll: (pairToken: string) => Promise<{ id: string; hostToken: string } | undefined>;
    // Which machine is presenting this token, or undefined. The only authorization on the WebSocket.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Drop a machine's enrollment — its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const hostEnrollmentsPath = (historyRoot: string): string => join(historyRoot, "host-enrollments.json");

export const fileHostsStore = (historyRoot: string): HostsStore => {
    const file = jsonFile<StoredHosts>(hostEnrollmentsPath(historyRoot), {
        parse: (raw) => StoredHostsSchema.safeParse(raw).data,
        fallback: () => ({ hosts: [] }),
        mode: 0o600,
    });
    // In memory, like sync's: a pairing outliving a daemon restart buys nothing (the browser mints another in
    // one click) and would mean persisting a live credential to protect.
    const pairings = new Map<string, { id: string; expiresAt: number }>();

    return {
        mintPairing: (id) => {
            const token = randomBytes(32).toString("base64url");
            pairings.set(token, { id, expiresAt: Date.now() + PAIR_TTL_MS });
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
            pairings.delete(pairToken);
            const hostToken = `iht_${randomBytes(32).toString("base64url")}`;
            const entry = { id: pairing.id, hash: sha256Hex(hostToken), enrolledAt: Date.now() };
            // Re-enrolling a machine ROTATES it: the old token stops verifying the moment the new one lands, so
            // re-running the installer on a machine that already had one is a clean replacement, not a second key.
            await file.update((stored) => ({ hosts: [...stored.hosts.filter((host) => host.id !== entry.id), entry] }));
            return { id: pairing.id, hostToken };
        },
        verify: async (presented) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe whatever the presented token's length.
            return (await file.read()).hosts.find((host) => tokenEquals(host.hash, hash))?.id;
        },
        enrolled: async (id) => (await file.read()).hosts.some((host) => host.id === id),
        revoke: async (id) => {
            let revoked = false;
            await file.update((stored) => {
                const next = stored.hosts.filter((host) => host.id !== id);
                revoked = next.length !== stored.hosts.length;
                return revoked ? { hosts: next } : stored;
            });
            return revoked;
        },
    };
};
