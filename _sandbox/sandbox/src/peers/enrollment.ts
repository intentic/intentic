import { randomBytes } from "node:crypto";
import { derivedMachineId, hostEntryOf, hostEnvironmentOf } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { tokenEquals } from "../auth/auth.js";
import { opt } from "../opt.js";
import { at, type JsonObject, transform } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";

// How something outside this sandbox becomes something it trusts, split into two halves by lifetime. A PAIRING is
// short-lived, single-use, in-memory; an ENROLLMENT is what redeeming one produces, the durable token stored on
// /history as digests only, so the file never holds anything that could present it.

// Long enough to walk over and paste, short enough that one leaked into a chat log is inert by the time it's read.
const PAIR_TTL_MS = 10 * 60 * 1000;

// Digests, never tokens: records that something was spent, without holding anything that could spend it.
const BurnedSchema = z.object({ digests: z.array(z.string()) });

// Each door's burn file; `pairings` picks the one its path names.
export const syncPairConsumedDocument = defineDocument({ root: "history", path: "sync-pair-consumed.json", schema: BurnedSchema });
export const hostPairConsumedDocument = defineDocument({ root: "history", path: "host-pair-consumed.json", schema: BurnedSchema });
export const webextPairConsumedDocument = defineDocument({ root: "history", path: "webext-pair-consumed.json", schema: BurnedSchema });
export const runnerPairConsumedDocument = defineDocument({ root: "history", path: "runner-pair-consumed.json", schema: BurnedSchema });
const burnDocuments = [syncPairConsumedDocument, hostPairConsumedDocument, webextPairConsumedDocument, runnerPairConsumedDocument];

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
// replayed, so `arm` refuses: an unauditable token must not be accepted. `ttlMs` is how long an unredeemed one lives.
export const pairings = <T>(burns?: string, ttlMs = PAIR_TTL_MS): Pairings<T> => {
    // A path naming none of the doors' burn files (a test's own) runs no conversions.
    const document = burns === undefined ? undefined : burnDocuments.find((spec) => burns.endsWith(`/${spec.path}`));
    const burned =
        burns === undefined
            ? undefined
            : jsonFile<z.infer<typeof BurnedSchema>>(burns, {
                  parse: (raw) => BurnedSchema.safeParse(raw).data,
                  fallback: () => ({ digests: [] }),
                  mode: 0o600,
                  ...opt("document", document),
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
            live.set(token, { payload, expiresAt: Date.now() + ttlMs, replayable: options?.replayable === true });
            // Nothing else times these out, so the sweep rides the one call that's neither hot nor latency-bound.
            for (const [key, pairing] of live) {
                if (pairing.expiresAt < Date.now()) {
                    live.delete(key);
                }
            }
            return { token, expiresIn: Math.floor(ttlMs / 1000) };
        },
        arm: async (token, payload) => {
            if (token === "" || burned === undefined || (await isBurned(token))) {
                return false;
            }
            live.set(token, { payload, expiresAt: Date.now() + ttlMs, replayable: true });
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

// Who is presenting a token — and, when nobody is, whether that is a fact about the token or merely this read's
// silence. The two are one answer everywhere else and must not be here: an unreadable manifest answers with the empty
// fallback (json-file.ts), and a door that reported that as "not enrolled" would tell a peer to throw away a
// credential this sandbox still holds.
// `card` is the capability card the enrollment is a connection of, read off the record (CardRule): what admission
// looks the grant up by.
export type Presented =
    | { readonly kind: "enrolled"; readonly id: string; readonly card: string }
    | { readonly kind: "unknown" }
    | { readonly kind: "unreadable"; readonly detail: string };

// WHICH CARD AN ENROLLMENT BELONGS TO, as data on the record rather than a rule for re-parsing its id. A door whose
// enrollments are their own cards (a browser) needs none; the hosts door records `card` beside each OS install's
// enrollment, so removing or renaming the card is one write over the records that say so.
export interface CardRule<X extends object> {
    // The card this record is a connection of.
    readonly of: (entry: { readonly id: string } & X) => string;
    // What a pairing for `id` records beside it: parsed once, from the id the owner asked to pair.
    readonly pairing: (id: string) => X;
    // The record under a renamed card: the card is a label on it, and the connection id follows from the label.
    readonly relabel: (entry: { readonly id: string } & X, card: string) => { readonly id: string } & X;
}

// A card per enrollment, which is every door without a rule of its own.
const identityRule = <X extends object>(): CardRule<X> => ({
    of: (entry) => entry.id,
    pairing: () => ({}) as X,
    relabel: (entry, card) => ({ ...entry, id: card }),
});

export interface Enrollments<X extends object> {
    // Enrolls an id and returns its durable token, the only time this daemon can see it. Re-issuing rotates: the old
    // token stops verifying the moment the new one lands, a clean replacement, not a second key.
    readonly issue: (id: string, extra: X) => Promise<string>;
    // Who is presenting this token; the only authorization these doors have.
    readonly verify: (presented: string) => Promise<Presented>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Everything enrolled, without the digest: who is here, which card each is a connection of, and whatever this door
    // keeps beside them.
    readonly list: () => Promise<({ readonly id: string; readonly card: string } & X)[]>;
    // Moves every enrollment of a card onto its new name in ONE write, leaving each digest untouched so the far end's
    // own key keeps verifying. Answers each connection id that moved, for the caller to cut its socket.
    readonly relabelCard: (from: string, to: string) => Promise<readonly { readonly from: string; readonly to: string }[]>;
    // Drops every enrollment of a card in ONE write; answers the connection ids dropped. A failure leaves all of them,
    // never some: the half-done loop this replaces left exactly the orphan it existed to prevent.
    readonly revokeCard: (card: string) => Promise<readonly string[]>;
    // Rewrites what this door keeps beside one enrollment (a machine that has now said which computer it is).
    readonly amend: (id: string, patch: Partial<X>) => Promise<void>;
    // Drops one enrollment; the next connect is refused. Closing the live socket is the caller's own half.
    readonly revoke: (id: string) => Promise<boolean>;
}

// Each door's enrollments file, spelled out per door since each keeps its own top-level key and its own fields beside
// the digest (a runner's host machine); `enrollments` picks the one its path names.
const EnrollmentSchema = z.object({ id: z.string(), hash: z.string(), enrolledAt: z.number() });

// A host enrollment is one OS install of one computer, lent to this sandbox by one card: `machineId` and `environment`
// say which install, `card` which grant. `id` is the connection key the hub and the MCP mount address it by, always
// `hostConnectionKey(card, environment)`, kept by the store on every write that touches either.
export const HostEnrollmentFieldsSchema = z.object({ card: z.string(), environment: z.string(), machineId: z.string() });
type LegacyHostEnrollment = JsonObject & { readonly id: string; readonly hash: string; readonly enrolledAt: number };
export const hostEnrollmentsDocument = defineDocument({
    root: "history",
    path: "host-enrollments.json",
    schema: z.object({ hosts: z.array(EnrollmentSchema.extend(HostEnrollmentFieldsSchema.shape)) }),
    history: [
        // 2026-09-25: an enrollment's card and environment were spelled only in its id (`<card>::<environment>`), and no
        // enrollment knew which computer it was on. Read off the id once; the machine id is derived from the card
        // until that environment's agent connects and says its own.
        at(
            "hosts.*",
            transform(
                "names the card, environment and machine of an enrollment that only spelled them in its id",
                (entry: JsonObject): entry is LegacyHostEnrollment =>
                    typeof entry["id"] === "string" && typeof entry["hash"] === "string" && typeof entry["enrolledAt"] === "number" && !Object.hasOwn(entry, "card"),
                (entry: LegacyHostEnrollment) => ({
                    ...entry,
                    card: hostEntryOf(entry.id),
                    environment: hostEnvironmentOf(entry.id),
                    machineId: derivedMachineId(hostEntryOf(entry.id)),
                }),
            ),
        ),
    ],
});
export const webextEnrollmentsDocument = defineDocument({
    root: "history",
    path: "webext-enrollments.json",
    schema: z.object({ browsers: z.array(EnrollmentSchema) }),
});
export const runnerEnrollmentsDocument = defineDocument({
    root: "history",
    path: "runner-enrollments.json",
    schema: z.object({ runners: z.array(EnrollmentSchema.extend({ host: z.string().optional() })) }),
});
const enrollmentDocuments = [hostEnrollmentsDocument, webextEnrollmentsDocument, runnerEnrollmentsDocument];

export const enrollments = <Shape extends z.ZodRawShape>(args: {
    // The file on /history; each door keeps its own name and top-level key, so this consolidates the mechanic, not the
    // bytes.
    readonly path: string;
    readonly key: string;
    // Shape of the durable token, so a credential seen in a log says which door it opens.
    readonly prefix: string;
    // What a door keeps beside the digest (a runner's host machine, say); `{}` when only the id matters.
    readonly extra: Shape;
    // Which card each record belongs to; absent, every enrollment is its own card.
    readonly card?: CardRule<z.infer<z.ZodObject<Shape>>> | undefined;
}): Enrollments<z.infer<z.ZodObject<Shape>>> => {
    type X = z.infer<z.ZodObject<Shape>>;
    const rule = args.card ?? identityRule<X>();
    // Written out rather than inferred from the schema: a generic spread of `extra` into `z.object` type-checks on the
    // way in but won't resolve `id`/`hash` structurally on the way out. The schema's job narrows to rejecting a file
    // this build can't read.
    type Entry = { id: string; hash: string; enrolledAt: number } & z.infer<z.ZodObject<Shape>>;
    const EntrySchema = z.object({ id: z.string(), hash: z.string(), enrolledAt: z.number(), ...args.extra });
    const StoredSchema = z.object({ [args.key]: z.array(EntrySchema) });

    // A path naming none of the doors' files (a test's own) runs no conversions.
    const document = enrollmentDocuments.find((spec) => args.path.endsWith(`/${spec.path}`));
    const file = jsonFile<Record<string, Entry[]>>(args.path, {
        parse: (raw) => StoredSchema.safeParse(raw).data as Record<string, Entry[]> | undefined,
        fallback: () => ({ [args.key]: [] }),
        mode: 0o600,
        ...opt("document", document),
    });

    const read = async (): Promise<Entry[]> => (await file.read())[args.key] ?? [];
    // A record without its digest and date: what a door's own rule and a reader get to see.
    const bare = (held: Entry): { readonly id: string } & X => {
        // TypeScript can't prove this equals `{ id } & Shape` while Shape is still a parameter; it does, by construction.
        const { hash: _hash, enrolledAt: _enrolledAt, ...rest } = held;
        return rest as { readonly id: string } & X;
    };
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
                return { kind: "unknown" };
            }
            // `state`, not `read`: the fallback an unreadable manifest answers with is indistinguishable from an empty
            // one, and this is the read where that difference decides whether a peer keeps its credential.
            const stored = await file.state();
            if (stored.unreadable) {
                return { kind: "unreadable", detail: stored.detail };
            }
            const hash = sha256Hex(presented);
            // Fixed-length hex digests, so the comparison is timing-safe regardless of the presented token's length.
            const held = (stored.value[args.key] ?? []).find((entry) => tokenEquals(entry.hash, hash));
            return held === undefined ? { kind: "unknown" } : { kind: "enrolled", id: held.id, card: rule.of(bare(held)) };
        },
        enrolled: async (id) => (await read()).some((held) => held.id === id),
        list: async () =>
            (await read()).map((held) => {
                const entry = bare(held);
                return { ...entry, card: rule.of(entry) } as { readonly id: string; readonly card: string } & X;
            }),
        relabelCard: async (from, to) => {
            const moved: { from: string; to: string }[] = [];
            await write((current) => {
                const next = current.map((held) => {
                    if (rule.of(bare(held)) !== from) {
                        return held;
                    }
                    const relabelled = rule.relabel(bare(held), to);
                    moved.push({ from: held.id, to: relabelled.id });
                    return { ...relabelled, hash: held.hash, enrolledAt: held.enrolledAt } as Entry;
                });
                return moved.length === 0 ? undefined : next;
            });
            return moved;
        },
        revokeCard: async (card) => {
            const dropped: string[] = [];
            await write((current) => {
                const next = current.filter((held) => {
                    const of = rule.of(bare(held)) === card;
                    if (of) {
                        dropped.push(held.id);
                    }
                    return !of;
                });
                return dropped.length === 0 ? undefined : next;
            });
            return dropped;
        },
        amend: async (id, patch) => {
            await write((current) => {
                const held = current.find((entry) => entry.id === id);
                if (held === undefined || Object.entries(patch).every(([key, value]) => (held as Record<string, unknown>)[key] === value)) {
                    return undefined;
                }
                // oxlint-disable-next-line oxc/no-map-spread -- an entry is readonly; a fresh record is the point
                return current.map((entry) => (entry.id === id ? ({ ...entry, ...patch } as Entry) : entry));
            });
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
