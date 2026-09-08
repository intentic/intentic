import { randomBytes } from "node:crypto";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { jsonFile } from "./json-file.js";

// How something outside this sandbox becomes something it trusts, split into two halves by lifetime. A PAIRING is
// short-lived, single-use, in-memory; an ENROLLMENT is what redeeming one produces, the durable token stored on
// /history as digests only, so the file never holds anything that could present it.

// Long enough to walk over and paste, short enough that one leaked into a chat log is inert by the time it's read.
const PAIR_TTL_MS = 10 * 60 * 1000;

// Digests, never tokens: records that something was spent, without holding anything that could spend it.
const BurnedSchema = z.object({ digests: z.array(z.string()) });

// A pairing minted and redeemed entirely in-process needs no burn record; one written somewhere immortal (a container's
// env, replayed into every rebuild) does, permanently. `replayable` is a property of one token, declared at mint time,
// not a per-store convention.
export interface Pairings<T> {
    // Mints a pairing carrying whatever its redemption needs. Pass `replayable` when the token is about to be written
    // somewhere that outlives this daemon.
    readonly mint: (payload: T, options?: { readonly replayable?: boolean }) => { token: string; expiresIn: number };
    // Arms a pre-agreed token from the container's env, immortal by definition, so refused once its digest is burned
    // (the ordinary case after the first boot). False means already spent, or empty, which isn't a pairing.
    readonly arm: (token: string, payload: T) => Promise<boolean>;
    // What this pairing grants, without spending it (prunes on expiry); lets a caller with fallible work before
    // consuming leave the token usable for a retry.
    readonly peek: (token: string) => T | undefined;
    // Spends it: out of memory, and onto the burn list when it was replayable.
    readonly consume: (token: string) => Promise<void>;
    // peek + consume, for callers whose redemption can't half-fail.
    readonly redeem: (token: string) => Promise<T | undefined>;
}

// `burns` is the /history file replayable pairings are recorded in. Omitting it declares nothing at this door can be
// replayed, so `arm` refuses: an unauditable token must not be accepted.
export const pairings = <T>(burns?: string): Pairings<T> => {
    const burned =
        burns === undefined
            ? undefined
            : jsonFile<z.infer<typeof BurnedSchema>>(burns, {
                  parse: (raw) => BurnedSchema.safeParse(raw).data,
                  fallback: () => ({ digests: [] }),
                  mode: 0o600,
              });
    const live = new Map<string, { payload: T; expiresAt: number; replayable: boolean }>();

    const isBurned = async (token: string): Promise<boolean> =>
        burned === undefined ? false : (await burned.read()).digests.includes(sha256Hex(token));

    const peek = (token: string): T | undefined => {
        const pairing = live.get(token);
        if (pairing === undefined) {
            return undefined;
        }
        if (pairing.expiresAt < Date.now()) {
            live.delete(token);
            return undefined;
        }
        return pairing.payload;
    };

    const consume = async (token: string): Promise<void> => {
        const replayable = live.get(token)?.replayable === true;
        live.delete(token);
        if (replayable) {
            const digest = sha256Hex(token);
            await burned?.update((stored) => (stored.digests.includes(digest) ? stored : { digests: [...stored.digests, digest] }));
        }
    };

    return {
        mint: (payload, options) => {
            const token = randomBytes(32).toString("base64url");
            live.set(token, { payload, expiresAt: Date.now() + PAIR_TTL_MS, replayable: options?.replayable === true });
            // Nothing else times these out, so the sweep rides the one call that's neither hot nor latency-bound.
            for (const [key, pairing] of live) {
                if (pairing.expiresAt < Date.now()) {
                    live.delete(key);
                }
            }
            return { token, expiresIn: Math.floor(PAIR_TTL_MS / 1000) };
        },
        arm: async (token, payload) => {
            if (token === "" || burned === undefined || (await isBurned(token))) {
                return false;
            }
            live.set(token, { payload, expiresAt: Date.now() + PAIR_TTL_MS, replayable: true });
            return true;
        },
        peek,
        consume,
        redeem: async (token) => {
            const payload = peek(token);
            if (payload === undefined) {
                return undefined;
            }
            // The burn list decides, not the map: a digest already on /history means this in-memory copy is a replay.
            if (await isBurned(token)) {
                live.delete(token);
                return undefined;
            }
            await consume(token);
            return payload;
        },
    };
};

export interface Enrollments<X extends object> {
    // Enrolls an id and returns its durable token, the only time this daemon can see it. Re-issuing rotates: the old
    // token stops verifying the moment the new one lands, a clean replacement, not a second key.
    readonly issue: (id: string, extra: X) => Promise<string>;
    // Who is presenting this token, or undefined; the only authorization these doors have.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Everything enrolled, without the digest: who is here and whatever this door keeps beside them.
    readonly list: () => Promise<({ readonly id: string } & X)[]>;
    // Moves an enrollment to a new id, leaving the digest untouched so the far end's own key keeps verifying under the
    // new name. Re-pairing to rename would mean re-running the installer for no reason.
    readonly rename: (from: string, to: string) => Promise<void>;
    // Drops it; the next connect is refused. Closing the live socket is the caller's own half.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const enrollments = <Shape extends z.ZodRawShape>(args: {
    // The file on /history; each door keeps its own name and top-level key, so this consolidates the mechanic, not the
    // bytes.
    readonly path: string;
    readonly key: string;
    // Shape of the durable token, so a credential seen in a log says which door it opens.
    readonly prefix: string;
    // What a door keeps beside the digest (a runner's host machine, say); `{}` when only the id matters.
    readonly extra: Shape;
}): Enrollments<z.infer<z.ZodObject<Shape>>> => {
    // Written out rather than inferred from the schema: a generic spread of `extra` into `z.object` type-checks on the
    // way in but won't resolve `id`/`hash` structurally on the way out. The schema's job narrows to rejecting a file
    // this build can't read.
    type Entry = { id: string; hash: string; enrolledAt: number } & z.infer<z.ZodObject<Shape>>;
    const EntrySchema = z.object({ id: z.string(), hash: z.string(), enrolledAt: z.number(), ...args.extra });
    const StoredSchema = z.object({ [args.key]: z.array(EntrySchema) });

    const file = jsonFile<Record<string, Entry[]>>(args.path, {
        parse: (raw) => StoredSchema.safeParse(raw).data as Record<string, Entry[]> | undefined,
        fallback: () => ({ [args.key]: [] }),
        mode: 0o600,
    });

    const read = async (): Promise<Entry[]> => (await file.read())[args.key] ?? [];
    // Returning the current array by reference skips the write, so revoking something that was never here is a no-op
    // that says so, not a rewrite of the file.
    const write = async (change: (current: Entry[]) => Entry[] | undefined): Promise<void> => {
        await file.update((stored) => {
            const next = change(stored[args.key] ?? []);
            return next === undefined ? stored : { [args.key]: next };
        });
    };

    return {
        issue: async (id, extra) => {
            const token = `${args.prefix}${randomBytes(32).toString("base64url")}`;
            // `extra` first: a door's own fields must never overwrite `id`, `hash`, or `enrolledAt`.
            const entry = { ...extra, id, hash: sha256Hex(token), enrolledAt: Date.now() } as Entry;
            await write((current) => [...current.filter((held) => held.id !== id), entry]);
            return token;
        },
        verify: async (presented) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe regardless of the presented token's length.
            return (await read()).find((held) => tokenEquals(held.hash, hash))?.id;
        },
        enrolled: async (id) => (await read()).some((held) => held.id === id),
        list: async () =>
            (await read()).map((held) => {
                // TypeScript can't prove this equals `{ id } & Shape` while Shape is still a parameter; it does, by
                // construction.
                const { hash: _hash, enrolledAt: _enrolledAt, ...rest } = held;
                return rest as { readonly id: string } & z.infer<z.ZodObject<Shape>>;
            }),
        rename: async (from, to) => {
            // oxlint-disable-next-line oxc/no-map-spread -- an entry is readonly; a fresh record under the new name is the point
            await write((current) => current.map((held) => (held.id === from ? { ...held, id: to } : held)));
        },
        revoke: async (id) => {
            let revoked = false;
            await write((current) => {
                const next = current.filter((held) => held.id !== id);
                revoked = next.length !== current.length;
                return revoked ? next : undefined;
            });
            return revoked;
        },
    };
};
