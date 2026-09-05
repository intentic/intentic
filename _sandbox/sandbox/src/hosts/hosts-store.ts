import { join } from "node:path";
import { enrollments, pairings } from "../store/enrollment.js";

/* The credential half of a `host` capability, the user's own device, enrolled once and then holding a
 * long-lived socket to this daemon (hosts/host-hub.ts is the live half).
 *
 * The mechanic is store/enrollment.ts, which four doors share; what is here is what is true of THIS door. The
 * owner mints a single-use, short-lived pairing in the browser and the one-liner carries it, or the setup
 * flow arms one it was given in the container's env, and the @intentic/machine agent redeems either exactly
 * once for a durable per-machine token. Nothing about the machine's identity is asserted by the machine: the
 * pairing already names WHICH capability it enrolls, so a redeemed token can only ever become the device
 * the owner was looking at when they clicked Connect.
 *
 * WHERE THIS LIVES IS THE POINT. On /history, not /work/.intentic: this token is a key to somebody's actual
 * laptop, and /work is the one directory the agent reads and writes all day. The bridge-token store made the
 * opposite call for a credential scoped to the agent's own surface (a stolen bridge token ≈ the agent's reach);
 * here a leak is a shell on the owner's machine, so the file sits where no tool the agent has can open it, and
 * holds digests rather than tokens even there. It also means an enrollment survives the `docker rm -f` of a
 * rebuild, exactly like sync's, the machine keeps working instead of silently going dark until someone
 * re-pairs it. */

export interface HostsStore {
    // Bind a pairing to one capability id. Single-use, expiring; the raw token is shown once, in the browser.
    readonly mintPairing: (id: string) => { token: string; expiresIn: number };
    /* Arm a pre-agreed pairing: the platform-minted setup-time token the connect flow passes in the container's
     * env, so the machine that just installed this sandbox can enroll itself without anyone opening a browser.
     * Answers false when the token has already been spent, which is the ordinary case on every boot after the
     * first. That burn is the whole reason a seeded pairing is marked replayable, and store/enrollment.ts says
     * why at length. */
    readonly seedPairing: (id: string, token: string) => Promise<boolean>;
    // Redeem a pairing: the machine gets its durable token, and the pairing is spent whether or not the machine
    // ever connects. Undefined ⇒ unknown or expired, which the route answers as 401.
    readonly enroll: (pairToken: string) => Promise<{ id: string; hostToken: string } | undefined>;
    // Which machine is presenting this token, or undefined. The only authorization on the WebSocket.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Move an enrollment onto a new capability id, keeping the machine's key valid, a renamed device must
    // not have to be re-paired by hand at the far end.
    readonly rename: (from: string, to: string) => Promise<void>;
    // Drop a machine's enrollment, its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const hostEnrollmentsPath = (historyRoot: string): string => join(historyRoot, "host-enrollments.json");

// The setup-time tokens that have been redeemed. Digests, never the tokens: this file records that something was
// spent, and needs to hold nothing that could spend anything.
export const hostSeedBurnPath = (historyRoot: string): string => join(historyRoot, "host-pair-consumed.json");

export const fileHostsStore = (historyRoot: string): HostsStore => {
    // A pairing carries the capability id it enrolls, and nothing else: this door has one thing to remember.
    const pending = pairings<string>(hostSeedBurnPath(historyRoot));
    const records = enrollments({ path: hostEnrollmentsPath(historyRoot), key: "hosts", prefix: "iht_", extra: {} });

    return {
        // Minted in the browser, so it dies with this daemon and there is nothing to burn.
        mintPairing: (id) => pending.mint(id),
        seedPairing: (id, token) => pending.arm(token, id),
        enroll: async (pairToken) => {
            const id = await pending.redeem(pairToken);
            return id === undefined ? undefined : { id, hostToken: await records.issue(id, {}) };
        },
        verify: records.verify,
        enrolled: records.enrolled,
        rename: records.rename,
        revoke: records.revoke,
    };
};
