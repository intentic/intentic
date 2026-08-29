import { randomBytes } from "node:crypto";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { jsonFile } from "./json-file.js";

/* HOW SOMETHING OUTSIDE THIS SANDBOX BECOMES SOMETHING IT TRUSTS, written once instead of four times.
 *
 * Four doors do exactly this — the user's computer (hosts/), their browser (webext/), one of this sandbox's
 * own runners (runners/) and a desktop-sync machine (platform/sync.ts) — and each carried its own copy of the
 * mechanic, about three quarters of it identical line for line. Length is not what made the copies worth
 * collapsing. It is that their differences had stopped being decisions: sync wrote its burn list with a bare
 * `writeFile`, the truncate-then-fill that json-file.ts exists to rule out, because it predated that
 * substrate and nobody re-read it when the others moved onto it. And the hosts store and the runners store
 * described the burn rule as two policies when it is one, stated below.
 *
 * TWO HALVES, split by lifetime, because only one of them is a credential anybody keeps.
 *
 * A PAIRING is the ten-minute thing: minted in a browser, or pre-agreed at setup time, single-use, and in
 * memory. A pairing that outlived a daemon restart would buy nothing — whoever wanted one mints another in a
 * click — at the price of keeping a live credential on disk.
 *
 * An ENROLLMENT is what redeeming a pairing produces: the durable token the far end presents on every
 * reconnect for as long as it is connected at all. It lives on /history — outside /work, which the agent
 * reads and writes all day, and outside the container, so a rebuild does not silently un-pair every machine —
 * and it lives there as DIGESTS, so the file records that something is enrolled while holding nothing that
 * could be used to present it. */

// How long a pairing may sit unredeemed: long enough to walk to the machine, open a terminal and paste; short
// enough that one left in a chat log is inert by the time anyone reads it. One window for all four doors,
// which are the same act with different words on the button.
const PAIR_TTL_MS = 10 * 60 * 1000;

// Digests, never the tokens: this file records that something was spent, and needs to hold nothing that could
// spend anything.
const BurnedSchema = z.object({ digests: z.array(z.string()) });

/* WHAT GETS BURNED, the one rule the four copies stated four ways.
 *
 * A redeemed pairing leaves memory, and for a browser-minted one that is the end of it: nothing outside this
 * process ever held the token, so there is nothing left to replay, and writing its digest down would grow a
 * file for security it already has.
 *
 * A pairing written somewhere IMMORTAL is the other case. A setup token in the container's environment is in
 * `docker inspect`, in the shell history of whoever ran the installer, and is replayed verbatim into every
 * rebuilt container; forgetting it is what turns a ten-minute window into a permanent key to a door that has
 * no bearer check on it. So its digest goes to /history, which outlives the container, and it never arms
 * again.
 *
 * `replayable` is that fact about one token, declared where the token is created, rather than a convention
 * each store has to remember. Hosts mint ephemeral pairings in the browser AND arm immortal ones from the
 * env, so theirs differ per pairing. Every runner pairing is immortal by construction — the parent mints it
 * and `ic runner up` writes it into a container's env — which is why that store looked like it held a
 * stricter rule. Nobody can pre-arrange a browser's pairing on their behalf, so webext has none of this and
 * never writes the file at all. */
export interface Pairings<T> {
    // Mint a pairing carrying whatever its redemption will need to know: which capability id it enrolls, which
    // mode it grants. Pass `replayable` when the token is about to be written somewhere that outlives this
    // daemon, which is a property of what the caller is about to do with it and of nothing else.
    readonly mint: (payload: T, options?: { readonly replayable?: boolean }) => { token: string; expiresIn: number };
    // Arm a pre-agreed token this daemon did not choose, handed to it in the container's env. Immortal by
    // definition, so it is refused once its digest is burned — the ordinary case on every boot after the
    // first. False ⇒ already spent, or empty, which is not a pairing.
    readonly arm: (token: string, payload: T) => Promise<boolean>;
    // What this pairing grants, without spending it (prunes on expiry). For the caller that has fallible work
    // to do before it can honestly consume: a failed enroll must leave the token usable for the retry.
    readonly peek: (token: string) => T | undefined;
    // Spend it: out of memory, and onto the burn list when it was replayable.
    readonly consume: (token: string) => Promise<void>;
    // peek + consume, for the callers whose redemption cannot half-fail.
    readonly redeem: (token: string) => Promise<T | undefined>;
}

// `burns` is the /history file the replayable ones are recorded in. Omitting it declares that nothing at this
// door can be replayed, which makes `arm` refuse: a token this daemon cannot check against a burn list is one
// it must not accept from outside.
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
            // Nothing times these out, so the sweep rides the one call that is neither hot nor latency-bound.
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
            /* The burn list decides, not the map. Whatever put this token back into memory, a digest already
             * on /history means it has been spent once and what this daemon is holding is a replay — which is
             * the check that has to survive somebody later adding a third way for a token to arrive. */
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
    /* Enroll an id and hand back its durable token, the only time that token exists anywhere this daemon can
     * see it. Re-issuing ROTATES: the previous token stops verifying the moment the new one lands, so
     * re-running an installer on a machine that already had one is a clean replacement rather than a second
     * key to the same door. */
    readonly issue: (id: string, extra: X) => Promise<string>;
    // Who is presenting this token, or undefined. The only authorization on the sockets these doors open.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Everything enrolled, without the digest: who is here, and whatever this door keeps beside them.
    readonly list: () => Promise<({ readonly id: string } & X)[]>;
    /* Move an enrollment onto a new id, leaving the digest untouched so the far end's own key keeps verifying
     * and simply comes back under the new name. Re-pairing would mean walking to that computer to run the
     * installer again, which is a strange price for changing what a row is called. */
    readonly rename: (from: string, to: string) => Promise<void>;
    // Drop it; the next connect is refused, and closing the live socket is the caller's half.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const enrollments = <Shape extends z.ZodRawShape>(args: {
    // The file on /history. Each door keeps its own name and its own top-level key, so what is already
    // enrolled stays enrolled: this consolidated the mechanic, not the bytes.
    readonly path: string;
    readonly key: string;
    // What the durable token looks like, so a credential in a log says which door it opens.
    readonly prefix: string;
    // What this door records beside the digest — runners: which computer holds the container. `{}` for the
    // doors that need nothing but the id.
    readonly extra: Shape;
}): Enrollments<z.infer<z.ZodObject<Shape>>> => {
    /* The record shape is written out rather than inferred back off the schema: a generic spread of `extra`
     * into `z.object` type-checks going in and stops resolving `id`/`hash` structurally coming out, so the
     * schema's job is narrowed to what it is actually for, which is rejecting a file this build cannot read. */
    type Entry = { id: string; hash: string; enrolledAt: number } & z.infer<z.ZodObject<Shape>>;
    const EntrySchema = z.object({ id: z.string(), hash: z.string(), enrolledAt: z.number(), ...args.extra });
    const StoredSchema = z.object({ [args.key]: z.array(EntrySchema) });

    const file = jsonFile<Record<string, Entry[]>>(args.path, {
        parse: (raw) => StoredSchema.safeParse(raw).data as Record<string, Entry[]> | undefined,
        fallback: () => ({ [args.key]: [] }),
        mode: 0o600,
    });

    const read = async (): Promise<Entry[]> => (await file.read())[args.key] ?? [];
    // Returning the current array by reference skips the write, which is what makes a revoke of something
    // that was never here a no-op that says so rather than a rewrite of the file.
    const write = async (change: (current: Entry[]) => Entry[] | undefined): Promise<void> => {
        await file.update((stored) => {
            const next = change(stored[args.key] ?? []);
            return next === undefined ? stored : { [args.key]: next };
        });
    };

    return {
        issue: async (id, extra) => {
            const token = `${args.prefix}${randomBytes(32).toString("base64url")}`;
            // `extra` first: what a door keeps beside the digest may never overwrite the three fields that
            // make the record an enrollment.
            const entry = { ...extra, id, hash: sha256Hex(token), enrolledAt: Date.now() } as Entry;
            await write((current) => [...current.filter((held) => held.id !== id), entry]);
            return token;
        },
        verify: async (presented) => {
            if (presented === "") {
                return undefined;
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe whatever the presented token's length.
            return (await read()).find((held) => tokenEquals(held.hash, hash))?.id;
        },
        enrolled: async (id) => (await read()).some((held) => held.id === id),
        list: async () =>
            (await read()).map((held) => {
                // Dropping two known keys off an intersection is `Omit<Entry, …>`, which TypeScript cannot
                // prove equals `{ id } & Shape` while Shape is still a parameter. It does, by construction.
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
