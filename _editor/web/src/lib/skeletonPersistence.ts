import { IMPRINT_VERSION, type ImprintElement, type SkeletonImprint } from "@intentic/ui/skeleton-imprint";
import { adoptImprints, configureSkeletonSnapshots, loadImprintScope, type SkeletonPersistence } from "@intentic/ui/skeleton-store";
import { z } from "zod";
import { activeSandboxId } from "./activeSandbox";
import { whenIdle } from "./whenIdle";

// Where the imprints loading placeholders are drawn from (@intentic/ui's <SkeletonSnapshot>) outlive the page:
// IndexedDB, one record per [sandbox, name], so a capture writes one small record off the main thread instead of
// rewriting a sandbox's whole set into localStorage on it. The active sandbox's imprints are read before the first
// route mounts (router/index.ts, beside the query cache), and every other sandbox's at the first idle moment after, so
// switching sandboxes draws remembered placeholders on its first frame rather than a frame late. Unlike the query
// cache, a new build keeps them: an imprint is geometry, still close for a view whose code changed, and taken again
// the moment that view settles.

const DB_NAME = `intentic.skeletons`;
const DB_VERSION = 1;
const STORE = `imprints`;
// An imprint nobody took for this long belongs to a view nobody opens; it goes at the next sweep.
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;
// Per sandbox, the newest this many of each kind: a view's own (`sandbox.secrets`), and one of many of a kind
// (`diff:${path}`, a transcript per conversation), which would otherwise grow forever and push the views out.
const KEPT_PER_SANDBOX = 100;
// How long the first paint may wait for the active sandbox's imprints. A slower disk costs them on that paint (the
// hand-drawn placeholders show, and the remembered ones replace them when the read lands), never the paint itself.
const RESTORE_BUDGET_MS = 250;
const SWEEP_IDLE_TIMEOUT_MS = 5_000;

const ImprintKeySchema = z.tuple([z.string(), z.string()]);
type ImprintKey = z.infer<typeof ImprintKeySchema>;

// Read back at the boundary, but only as deep as the record's own frame: walking every node of every imprint would
// cost a boot what the imprints save it. The tree under `root` is what `takeImprint` wrote, under this same version.
const ImprintRecordSchema = z
    .object({
        v: z.literal(IMPRINT_VERSION),
        at: z.number(),
        t: z.array(z.string()),
        root: z.looseObject({ e: z.string() }),
    })
    .transform(({ root, ...frame }): SkeletonImprint => {
        // SAFETY: only `save` writes this store, and only `takeImprint`'s output, at the IMPRINT_VERSION checked above.
        const tree = root as ImprintElement;
        return { ...frame, root: tree };
    });

const imprintIn = (record: IDBCursorWithValue[`value`]): SkeletonImprint | undefined => {
    const parsed = ImprintRecordSchema.safeParse(record);
    return parsed.success ? parsed.data : undefined;
};

const keyOf = (key: IDBValidKey): ImprintKey | undefined => {
    const parsed = ImprintKeySchema.safeParse(key);
    return parsed.success ? parsed.data : undefined;
};

let connection: Promise<IDBDatabase | undefined> | undefined;

const openDb = (): Promise<IDBDatabase | undefined> => {
    connection ??= new Promise<IDBDatabase | undefined>((resolve) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.addEventListener(`upgradeneeded`, () => {
                if (!request.result.objectStoreNames.contains(STORE)) {
                    request.result.createObjectStore(STORE);
                }
            });
            request.addEventListener(`success`, () => {
                // Closes on a version change instead of blocking it, as transcriptCache.ts does.
                request.result.addEventListener(`versionchange`, () => {
                    request.result.close();
                    connection = undefined;
                });
                resolve(request.result);
            });
            // Blocked, denied, or a version clash: every caller degrades to imprints that last as long as the page.
            request.addEventListener(`error`, () => resolve(undefined));
            request.addEventListener(`blocked`, () => resolve(undefined));
        } catch {
            resolve(undefined);
        }
    });
    return connection;
};

// One transaction, resolved when it commits (or with `fallback` when it cannot): `act` queues its requests on the
// store and returns how to read what they will have collected by then.
const transact = async <T>(mode: IDBTransactionMode, fallback: T, act: (store: IDBObjectStore) => () => T): Promise<T> => {
    const db = await openDb();
    if (db === undefined) {
        return fallback;
    }
    return new Promise<T>((resolve) => {
        try {
            const transaction = db.transaction(STORE, mode);
            const collected = act(transaction.objectStore(STORE));
            transaction.addEventListener(`complete`, () => resolve(collected()));
            transaction.addEventListener(`abort`, () => resolve(fallback));
            transaction.addEventListener(`error`, () => resolve(fallback));
        } catch {
            resolve(fallback);
        }
    });
};

const scopeRange = (scope: string): IDBKeyRange => IDBKeyRange.bound([scope], [scope, []]);

const load = (scope: string): Promise<ReadonlyMap<string, SkeletonImprint>> =>
    transact(`readonly`, new Map<string, SkeletonImprint>(), (store) => {
        const records = store.getAll(scopeRange(scope));
        const keys = store.getAllKeys(scopeRange(scope));
        return () => {
            const found = new Map<string, SkeletonImprint>();
            keys.result.forEach((key, index) => {
                const name = keyOf(key)?.[1];
                const imprint = imprintIn(records.result[index]);
                if (name !== undefined && imprint !== undefined) {
                    found.set(name, imprint);
                }
            });
            return found;
        };
    });

const save = (scope: string, imprints: ReadonlyMap<string, SkeletonImprint>): Promise<void> =>
    transact(`readwrite`, undefined, (store) => {
        for (const [name, imprint] of imprints) {
            store.put(imprint, [scope, name]);
        }
        return () => undefined;
    });

const clear = (): Promise<void> =>
    transact(`readwrite`, undefined, (store) => {
        store.clear();
        return () => undefined;
    });

const persistence: SkeletonPersistence = { load, save, clear };

interface Held {
    readonly key: ImprintKey;
    readonly imprint: SkeletonImprint;
}

// A variant names its kind before a colon (`diff:src/app.ts`); a view's own name has none.
const isVariant = (name: string): boolean => name.includes(`:`);

/**
 * One sandbox's imprints split into those kept and those past the cap: the newest `cap` views and the newest `cap`
 * variants, so a day of opened conversations never pushes the settings pages out.
 */
export interface Outgrown<T> {
    readonly kept: readonly T[];
    readonly dropped: readonly T[];
}

export const outgrown = <T extends { readonly name: string; readonly at: number }>(held: readonly T[], cap = KEPT_PER_SANDBOX): Outgrown<T> => {
    const newest = held.toSorted((left, right) => right.at - left.at);
    const views = newest.filter((entry) => !isVariant(entry.name));
    const variants = newest.filter((entry) => isVariant(entry.name));
    return { kept: [...views.slice(0, cap), ...variants.slice(0, cap)], dropped: [...views.slice(cap), ...variants.slice(cap)] };
};

// Each sandbox's oldest past the cap of their kind, deleted once the cursor has seen them all.
const trim = (store: IDBObjectStore, kept: Map<string, Held[]>): void => {
    for (const [scope, held] of kept) {
        const { kept: staying, dropped } = outgrown(held.map((entry) => ({ ...entry, name: entry.key[1], at: entry.imprint.at })));
        for (const over of dropped) {
            store.delete([...over.key]);
        }
        kept.set(scope, [...staying]);
    }
};

// Over every record once: drops what is stale or of another encoding, keeps each sandbox's newest of each kind, and
// hands what survives to memory, so every sandbox's imprints are there before the reader switches to it.
const sweep = (now: number): Promise<ReadonlyMap<string, readonly Held[]>> =>
    transact(`readwrite`, new Map<string, Held[]>(), (store) => {
        const kept = new Map<string, Held[]>();
        const cursor = store.openCursor();
        cursor.addEventListener(`success`, () => {
            const at = cursor.result;
            if (at === null) {
                trim(store, kept);
                return;
            }
            const key = keyOf(at.primaryKey);
            const imprint = imprintIn(at.value);
            if (key !== undefined && imprint !== undefined && now - imprint.at <= KEPT_MS) {
                const held = kept.get(key[0]) ?? [];
                held.push({ key, imprint });
                kept.set(key[0], held);
            } else {
                at.delete();
            }
            at.continue();
        });
        return () => kept;
    });

let swept = false;

const sweepOnce = async (): Promise<void> => {
    if (swept) {
        return;
    }
    swept = true;
    for (const [scope, held] of await sweep(Date.now())) {
        adoptImprints(scope, new Map(held.map(({ key, imprint }) => [key[1], imprint])));
    }
};

/** The scope every imprint is read and written under: the sandbox the browser is pointed at. */
const sandboxScope = (): string => activeSandboxId.value ?? `none`;

/** Points @intentic/ui's imprint store at the active sandbox and at IndexedDB. Once, at boot, before anything mounts. */
export const installSkeletonPersistence = (): void => configureSkeletonSnapshots({ scope: sandboxScope, persistence });

/**
 * Reads the active sandbox's imprints before the first route mounts, within a budget, then sweeps every sandbox's at
 * the first idle moment. Awaited beside the query cache's restore, so it adds no wait unless the disk is slower.
 */
export const restoreImprints = async (): Promise<void> => {
    await Promise.race([loadImprintScope(sandboxScope()), new Promise((resolve) => setTimeout(resolve, RESTORE_BUDGET_MS))]);
    whenIdle(() => void sweepOnce(), SWEEP_IDLE_TIMEOUT_MS);
};
