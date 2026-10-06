import { stashedToken } from "@intentic/sandbox-contract";
import { randomBytes } from "node:crypto";

// Credentials the sandbox made for a form that has not been saved yet (a generated SSH key's private half), held in
// memory under a one-time token: the browser holds the token, never the value. A token installs its value once, and
// lapses after the TTL whether used or not. Nothing here touches disk, so a restart forgets them, which costs only a
// fresh key; what an add installs goes where every other credential goes, the vault.

// Long enough to go and authorize a public key on a server and come back to save the form.
export const STASH_TTL_MS = 30 * 60_000;
// More than one person keeps forms open; past it the oldest go first, so a caller that loops cannot grow this.
const STASH_LIMIT = 32;

export interface StashedSecret {
    // Where the value may be installed, checked when a marker is resolved: a key made for an SSH connection's private
    // key is never accepted as another kind's credential, which could send it to whatever host that kind dials.
    readonly kind: string;
    readonly field: string;
    readonly value: string;
}

export interface SecretStash {
    // Holds a value under a fresh token and answers the token.
    readonly put: (secret: StashedSecret) => string;
    // What a live token holds; looking leaves it held.
    readonly peek: (token: string) => StashedSecret | undefined;
    // Drops a token once its value is stored for good, so it cannot install that value a second time.
    readonly spend: (token: string) => void;
}

export const createSecretStash = ({ ttlMs = STASH_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {}): SecretStash => {
    const held = new Map<string, { readonly secret: StashedSecret; readonly expiresAt: number }>();
    const prune = (): void => {
        const at = now();
        for (const [token, entry] of held) {
            if (entry.expiresAt <= at) {
                held.delete(token);
            }
        }
    };
    return {
        put: (secret) => {
            prune();
            // A Map iterates in insertion order, so its first key is the oldest.
            for (const oldest of [...held.keys()].slice(0, Math.max(0, held.size - STASH_LIMIT + 1))) {
                held.delete(oldest);
            }
            const token = randomBytes(24).toString("base64url");
            held.set(token, { secret, expiresAt: now() + ttlMs });
            return token;
        },
        peek: (token) => {
            prune();
            return held.get(token)?.secret;
        },
        spend: (token) => {
            held.delete(token);
        },
    };
};

// A marker that cannot be resolved, in words for the person holding the form; the route answers it as a bad request.
export class StashRefusal extends Error {}

// Each stash marker in a config, swapped for the value its token holds. Looks only: the add spends the tokens once the
// connection is written, so a failed apply can be retried with the same key rather than with a new one the server has
// never seen.
export const unstash = (stash: SecretStash, kind: string, config: Readonly<Record<string, unknown>>): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const [field, value] of Object.entries(config)) {
        const token = stashedToken(value);
        if (token === undefined) {
            continue;
        }
        const held = stash.peek(token);
        if (held === undefined) {
            throw new StashRefusal(
                "that generated key is no longer held: it was already saved, it lapsed after thirty minutes, or the sandbox restarted since. Generate a new one and authorize that one on the server instead",
            );
        }
        if (held.kind !== kind || held.field !== field) {
            throw new StashRefusal(
                `that generated key was made to be the ${held.field} of a ${held.kind} entry, so it is not used as ${kind} ${field}`,
            );
        }
        values[field] = held.value;
    }
    return values;
};

// Spends every token a config names; called once the values they stood for are stored.
export const spendStashed = (stash: SecretStash, config: Readonly<Record<string, unknown>>): void => {
    for (const value of Object.values(config)) {
        const token = stashedToken(value);
        if (token !== undefined) {
            stash.spend(token);
        }
    }
};
