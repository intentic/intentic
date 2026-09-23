import type { AgentEvent, AttachFrame, TranscriptRow } from "@intentic/sandbox-contract";

// What conversations hold beside their state, by kind: each conversation's share sits on its actor, every item's id is
// indexed to its holder, and what no conversation holds waits in a bucket of its own. The actors registry lends each
// actor's share and releases through here, so its one dispose reaches every kind declared anywhere.

// A kind of thing conversations hold (parked cards, children, jobs, watches), declared once by the module whose records
// they are. `dropped` is how that module lets go of one a dispose took: a waiter to settle, a timer to clear.
export interface Holding<V> {
    readonly name: string;
    readonly dropped?: (value: V) => void;
}

// One kind's items across the fleet, each under an id unique to its kind. An item held by no conversation (a card raised
// outside any) waits in the conversationless bucket, which no dispose reaches.
export interface Holdings<V> {
    readonly get: (id: string) => V | undefined;
    readonly has: (id: string) => boolean;
    // Undefined for an item in the conversationless bucket as for no item at all.
    readonly holder: (id: string) => string | undefined;
    // One conversation's, in the order each was first held.
    readonly of: (conversationId: string) => readonly V[];
    // Every item with its id, the bucket's included, in the order each was first held.
    readonly entries: () => readonly (readonly [string, V])[];
    // Replaces whatever was filed under `id`. `about` is a second conversation the item concerns (a child's record in its
    // parent's collection), whose dispose takes it too.
    readonly hold: (holder: string | undefined, id: string, value: V, about?: string) => void;
    readonly drop: (id: string) => boolean;
    // Every item of the kind, everywhere, with no `dropped` for any: a suite's clean slate.
    readonly clear: () => void;
}

// One actor's share of every holding: by kind, then by item id. Keyed by the declaration itself, which any `Holding<V>`
// is assignable to.
export type Share = Map<Holding<never>, Map<string, unknown>>;

export interface HoldingsIndex {
    readonly holdings: <V>(kind: Holding<V>) => Holdings<V>;
    // The names of the kinds holding anything of this conversation's, held by it or about it.
    readonly traces: (conversationId: string) => readonly string[];
    // Takes everything held by or about these conversations out of every index and share, and answers the `dropped`
    // calls owed, for the caller to make once the actors themselves are gone.
    readonly release: (conversationIds: ReadonlySet<string>) => readonly (() => void)[];
}

// Where one item is filed: the conversation holding it (none for the bucket's), and a second one it concerns.
interface Filing {
    readonly holder: string | undefined;
    readonly about: string | undefined;
}

interface Kind {
    readonly name: string;
    readonly index: Map<string, Filing>;
    readonly dropped: ((value: unknown) => void) | undefined;
}

const shelf = <K, V>(map: Map<K, Map<string, V>>, key: K): Map<string, V> => {
    const existing = map.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const fresh = new Map<string, V>();
    map.set(key, fresh);
    return fresh;
};

const concerns = (filing: Filing, conversationIds: ReadonlySet<string>): boolean =>
    (filing.holder !== undefined && conversationIds.has(filing.holder)) || (filing.about !== undefined && conversationIds.has(filing.about));

// `shareOf` lends a conversation's share, making its actor only when asked to.
export const createHoldingsIndex = (shareOf: (holder: string, create: boolean) => Share | undefined): HoldingsIndex => {
    const kinds = new Map<Holding<never>, Kind>();
    const bucket: Share = new Map();

    const kindOf = <V>(declared: Holding<V>): Kind => {
        const existing = kinds.get(declared);
        if (existing !== undefined) {
            return existing;
        }
        const { dropped } = declared;
        // The one place a stored value is read back as the kind it was declared with.
        const fresh: Kind = { name: declared.name, index: new Map(), dropped: dropped === undefined ? undefined : (value) => dropped(value as V) };
        kinds.set(declared, fresh);
        return fresh;
    };

    // The map an item filed under `holder` lives in; undefined for a holder with no actor, unless asked to make one.
    const placeOf = (declared: Holding<never>, holder: string | undefined, create: boolean): Map<string, unknown> | undefined => {
        if (holder === undefined) {
            return create ? shelf(bucket, declared) : bucket.get(declared);
        }
        const share = shareOf(holder, create);
        return create && share !== undefined ? shelf(share, declared) : share?.get(declared);
    };

    // Unfiles one item and answers it, or undefined when nothing was filed under the id.
    const unfile = (declared: Holding<never>, kind: Kind, id: string): { readonly value: unknown } | undefined => {
        const filing = kind.index.get(id);
        if (filing === undefined) {
            return undefined;
        }
        kind.index.delete(id);
        const place = placeOf(declared, filing.holder, false);
        const value = place?.get(id);
        place?.delete(id);
        return { value };
    };

    const accessors = new Map<Holding<never>, Holdings<unknown>>();
    const accessorOf = <V>(declared: Holding<V>): Holdings<V> => {
        const kind = kindOf(declared);
        const read = (id: string): V | undefined => placeOf(declared, kind.index.get(id)?.holder, false)?.get(id) as V | undefined;
        return {
            get: read,
            has: (id) => kind.index.has(id),
            holder: (id) => kind.index.get(id)?.holder,
            of: (conversationId) => [...(placeOf(declared, conversationId, false)?.values() ?? [])] as V[],
            entries: () => [...kind.index.keys()].map((id) => [id, read(id) as V] as const),
            hold: (holder, id, value, about) => {
                // Moving to another holder refiles it at the end, as a first hold would.
                if (kind.index.get(id)?.holder !== holder) {
                    unfile(declared, kind, id);
                }
                kind.index.set(id, { holder, about });
                placeOf(declared, holder, true)?.set(id, value);
            },
            drop: (id) => unfile(declared, kind, id) !== undefined,
            clear: () => {
                for (const id of kind.index.keys()) {
                    unfile(declared, kind, id);
                }
            },
        };
    };
    // One accessor per kind, since doors on a frame's path ask for theirs on every frame.
    const holdings = <V>(declared: Holding<V>): Holdings<V> => {
        const existing = accessors.get(declared) as Holdings<V> | undefined;
        if (existing !== undefined) {
            return existing;
        }
        const fresh = accessorOf(declared);
        accessors.set(declared, fresh as Holdings<unknown>);
        return fresh;
    };

    return {
        holdings,
        traces: (conversationId) => {
            const one = new Set([conversationId]);
            return [...kinds.values()].filter((kind) => [...kind.index.values()].some((filing) => concerns(filing, one))).map((kind) => kind.name);
        },
        release: (conversationIds) => {
            const owed: (() => void)[] = [];
            for (const [declared, kind] of kinds) {
                const { dropped } = kind;
                // Deleting the entry being visited is safe under Map iteration.
                for (const [id, filing] of kind.index) {
                    const taken = concerns(filing, conversationIds) ? unfile(declared, kind, id) : undefined;
                    if (taken !== undefined && dropped !== undefined) {
                        owed.push(() => dropped(taken.value));
                    }
                }
            }
            return owed;
        },
    };
};

/* ---- the conversation's run ---- */

// How long a finished run stays attachable: a reconnect retries within seconds, a minute covers its whole ladder.
export const RUN_RETAINED_MS = 60_000;

// The one entry of an attach stream past its head: a change to the rows, or a fact about the turn.
export type AttachEntry = Extract<AttachFrame, { kind: "patch" | "fact" }>;
export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

// A conversation's detached run (agent/run/turn/turn-runs.ts), as whoever holds only the conversation reads it.
export interface LiveRun {
    readonly id: string;
    readonly startedAt: number;
    readonly done: boolean;
    // The transcript as it stands, live.
    readonly rows: readonly TranscriptRow[];
    // Finished, and past RUN_RETAINED_MS.
    readonly expired: (now: number) => boolean;
    // One helper's transcript, by the id of the call that spawned it.
    readonly rowsOf: (tag: string) => readonly TranscriptRow[];
    readonly metrics: () => { readonly rows: number; readonly followers: number };
    readonly push: (event: AgentEvent) => void;
    // A row the daemon writes on the turn's behalf.
    readonly note: (row: TranscriptRow) => void;
    // Resolves once the run has fully unwound.
    readonly waitUntilFinished: () => Promise<void>;
    readonly attach: () => { readonly head: AttachHead; readonly entries: AsyncGenerator<AttachEntry> };
    // Raw frames from this instant on.
    readonly frames: () => AsyncGenerator<AgentEvent>;
}

// Held by its conversation under the conversation's own id: one run at a time, the newest replacing the last.
export const RUNS: Holding<LiveRun> = { name: "turn runs" };

// Every run held, less the ones past retention, which are dropped as they are found.
const retained = (actors: Pick<HoldingsIndex, "holdings">): readonly (readonly [string, LiveRun])[] => {
    const runs = actors.holdings(RUNS);
    const now = Date.now();
    const kept: (readonly [string, LiveRun])[] = [];
    for (const [conversationId, run] of runs.entries()) {
        if (run.expired(now)) {
            runs.drop(conversationId);
        } else {
            kept.push([conversationId, run]);
        }
    }
    return kept;
};

// The conversation's run, live or finished within retention; undefined means nothing to attach to.
export const turnRunOf = (actors: Pick<HoldingsIndex, "holdings">, conversationId: string): LiveRun | undefined => {
    const runs = actors.holdings(RUNS);
    const run = runs.get(conversationId);
    if (run?.expired(Date.now()) === true) {
        runs.drop(conversationId);
        return undefined;
    }
    return run;
};

// The one conversation with a live run, when exactly one exists. Two are an honest "don't know": guessing would park a
// card in the wrong conversation.
export const soleLiveConversation = (actors: Pick<HoldingsIndex, "holdings">): string | undefined => {
    const live = retained(actors).filter(([, run]) => !run.done);
    return live.length === 1 ? live[0]?.[0] : undefined;
};

// Every conversation with a turn still running, with when it started; the full set, for readers comparing it against a
// second record of the same fact (journal, fleet registry).
export const liveTurnConversations = (
    actors: Pick<HoldingsIndex, "holdings">,
): readonly { readonly conversationId: string; readonly startedAt: number }[] =>
    retained(actors)
        .filter(([, run]) => !run.done)
        .map(([conversationId, run]) => ({ conversationId, startedAt: run.startedAt }));

export const turnRunMetrics = (actors: Pick<HoldingsIndex, "holdings">): Readonly<Record<string, number>> => {
    const runs = retained(actors);
    const held = runs.map(([, run]) => run.metrics());
    const live = runs.filter(([, run]) => !run.done).length;
    return {
        runs: runs.length,
        live,
        retained: runs.length - live,
        rows: held.reduce((total, metrics) => total + metrics.rows, 0),
        followers: held.reduce((total, metrics) => total + metrics.followers, 0),
    };
};
