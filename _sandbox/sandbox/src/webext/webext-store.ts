import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { jsonFile } from "../store/json-file.js";

/* The credential half of a `webext` capability — the user's own browser, paired once and then holding a
 * long-lived socket to this daemon (webext/webext-hub.ts is the live half).
 *
 * The hosts-store shape (hosts/hosts-store.ts) with the seeding half removed, and the removal is the whole
 * difference between the two. A computer is connected by an installer this platform can hand a token to at
 * provision time; a browser is connected by a person clicking Add in an extension's popup, which no installer
 * can do on their behalf and no container environment can pre-arm. So there is exactly one way in — an
 * owner-minted pairing, redeemed once — and nothing to burn afterwards.
 *
 * WHERE THIS LIVES IS THE POINT, exactly as it is for a machine's token. On /history, not /work/.intentic: a
 * durable token here is a socket into somebody's signed-in browser, and /work is the one directory the agent
 * reads and writes all day. The file holds digests rather than tokens even there, and it survives the
 * `docker rm -f` of a rebuild, so an owner does not have to re-pair a browser every time their sandbox
 * updates. */

const StoredExtensionsSchema = z.object({
    browsers: z.array(
        z.object({
            // The capability id — the browser's name, and the prefix of its tools. One enrollment per browser,
            // so re-pairing rotates rather than adding a second key.
            id: z.string(),
            hash: z.string(),
            enrolledAt: z.number(),
        }),
    ),
});
type StoredExtensions = z.infer<typeof StoredExtensionsSchema>;

// Long enough to switch windows, open the popup and paste; short enough that a code left in a chat log is
// inert by the time anyone reads it. The hosts pairing's window, for the same reasons.
const PAIR_TTL_MS = 10 * 60 * 1000;

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
    const file = jsonFile<StoredExtensions>(webextEnrollmentsPath(historyRoot), {
        parse: (raw) => StoredExtensionsSchema.safeParse(raw).data,
        fallback: () => ({ browsers: [] }),
        mode: 0o600,
    });
    // In memory, like the hosts store's: a pairing outliving a daemon restart buys nothing (the browser mints
    // another in one click) and would mean persisting a live credential to protect.
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
            const extensionToken = `iwx_${randomBytes(32).toString("base64url")}`;
            const entry = { id: pairing.id, hash: sha256Hex(extensionToken), enrolledAt: Date.now() };
            // Re-pairing a browser ROTATES it: the old token stops verifying the moment the new one lands, so
            // reinstalling the extension is a clean replacement rather than a second key to the same browser.
            await file.update((stored) => ({ browsers: [...stored.browsers.filter((entry_) => entry_.id !== entry.id), entry] }));
            return { id: pairing.id, extensionToken };
        },
        verify: async (presented) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe whatever the presented token's length.
            return (await file.read()).browsers.find((browser) => tokenEquals(browser.hash, hash))?.id;
        },
        enrolled: async (id) => (await file.read()).browsers.some((browser) => browser.id === id),
        rename: async (from, to) => {
            // The token digest is untouched, so the extension's own key keeps verifying — it simply comes back
            // under the new name, and nobody has to open a browser to re-pair a row that was only renamed.
            await file.update((stored) => ({ browsers: stored.browsers.map((browser) => (browser.id === from ? { ...browser, id: to } : browser)) }));
        },
        revoke: async (id) => {
            let revoked = false;
            await file.update((stored) => {
                const next = stored.browsers.filter((browser) => browser.id !== id);
                revoked = next.length !== stored.browsers.length;
                return revoked ? { browsers: next } : stored;
            });
            return revoked;
        },
    };
};
