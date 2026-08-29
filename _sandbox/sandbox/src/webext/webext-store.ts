import { join } from "node:path";
import { enrollments, pairings } from "../store/enrollment.js";

/* The credential half of a `webext` capability — the user's own browser, paired once and then holding a
 * long-lived socket to this daemon (webext/webext-hub.ts is the live half).
 *
 * The shared mechanic (store/enrollment.ts) with the seeded-pairing half unused, and that absence is the whole
 * difference between this door and the machines'. A computer is connected by an installer this platform can
 * hand a token to at provision time; a browser is connected by a person clicking Add in an extension's popup,
 * which no installer can do on their behalf and no container environment can pre-arm. So there is exactly one
 * way in — an owner-minted pairing, redeemed once — nothing here is ever replayable, and this door has no burn
 * file at all.
 *
 * WHERE THIS LIVES IS THE POINT, exactly as it is for a machine's token. On /history, not /work/.intentic: a
 * durable token here is a socket into somebody's signed-in browser, and /work is the one directory the agent
 * reads and writes all day. The file holds digests rather than tokens even there, and it survives the
 * `docker rm -f` of a rebuild, so an owner does not have to re-pair a browser every time their sandbox
 * updates. */

export interface WebExtStore {
    // Bind a pairing to one capability id. Single-use, expiring; the raw code is shown once, in the browser.
    readonly mintPairing: (id: string) => { token: string; expiresIn: number };
    // Redeem a pairing: the extension gets its durable token, and the pairing is spent whether or not the
    // extension ever connects. Undefined ⇒ unknown or expired, which the route answers as 401.
    readonly enroll: (pairToken: string) => Promise<{ id: string; extensionToken: string } | undefined>;
    // Which browser is presenting this token, or undefined. The only authorization on the WebSocket, and on
    // the session-import door.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Move an enrollment onto a new capability id, keeping the extension's key valid: a renamed browser must
    // not have to be re-paired by hand at the far end.
    readonly rename: (from: string, to: string) => Promise<void>;
    // Drop a browser's enrollment; its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const webextEnrollmentsPath = (historyRoot: string): string => join(historyRoot, "webext-enrollments.json");

export const fileWebExtStore = (historyRoot: string): WebExtStore => {
    // No burn file: nothing can pre-arrange a pairing here, so every one of them dies with this daemon and
    // there has never been anything to record as spent.
    const pending = pairings<string>();
    const records = enrollments({ path: webextEnrollmentsPath(historyRoot), key: "browsers", prefix: "iwx_", extra: {} });

    return {
        mintPairing: (id) => pending.mint(id),
        enroll: async (pairToken) => {
            const id = await pending.redeem(pairToken);
            return id === undefined ? undefined : { id, extensionToken: await records.issue(id, {}) };
        },
        verify: records.verify,
        enrolled: records.enrolled,
        rename: records.rename,
        revoke: records.revoke,
    };
};
