import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { sha256Hex } from "../lib/files/contentHash";

// This browser's copy of the extension bundles the daemon serves (loader.ts), in Cache Storage, so a page load whose list
// names a bundle the browser already holds imports it without downloading it again. A copy is kept only under a revision
// that names exactly one bundle's bytes, and is checked against it going in and coming out; anything else is fetched on
// every load, as before. Sign-out deletes the whole cache by this name (client/auth/useAuth.ts), since the client layer
// may not import the extension host.
export const EXTENSION_BUNDLE_CACHE = `intentic.extensionBundles`;

// What a list row has to say for its bundle to be named exactly: where it comes from, which commit, which build.
export type ServedSummary = Pick<ExtensionSummary, `id` | `source` | `commit` | `dev` | `previous`> & {
    readonly manifest: Pick<ExtensionSummary[`manifest`], `entry`>;
};

// The one bundle a row's code is: a pinned commit, or the fingerprint of a source checkout's build.
export interface BundleRevision {
    readonly kind: `commit` | `dev`;
    readonly value: string;
}

// A full commit id (SHA-1, or SHA-256 in a repository that uses it), the form the list reports a pinned install in.
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// extension-dev.ts `bundleRevisionOf`: the first 12 hex digits of the served bundle's sha256.
const DEV_FINGERPRINT = /^[0-9a-f]{12}$/u;

// Which exact bundle a listed extension runs, or undefined when its row names none. Mirrors the daemon's rule for the
// bundle's ETag (extension-bundle.routes.ts `pinned`): a git install serves its pinned clone unless it is pointed at a
// source checkout that is not held, and then serves that checkout's build.
// - pinned: the full commit. The clone is checked out at it and the bundle is committed in it, so the commit names the
//   bytes, which is why the daemon hands it out as the ETag.
// - from a checkout: `dev.revision`, a hash of the bundle being served, which every cached copy is hashed against.
// A built-in's or a workspace folder's `commit` is the word for its source, and a workspace folder is edited in place:
// neither is ever cached, and neither is anything else that does not fit these shapes.
export const exactRevisionOf = (summary: Pick<ServedSummary, `source` | `commit` | `dev`>): BundleRevision | undefined => {
    if (summary.source !== `installed`) {
        return undefined;
    }
    const { dev } = summary;
    if (dev === undefined || dev.held !== undefined) {
        return FULL_COMMIT.test(summary.commit) ? { kind: `commit`, value: summary.commit } : undefined;
    }
    return dev.revision !== undefined && DEV_FINGERPRINT.test(dev.revision) ? { kind: `dev`, value: dev.revision } : undefined;
};

// Entries are addressed by URL (Cache Storage takes http(s) only); this host never resolves, and nothing is fetched from it.
const KEY_ORIGIN = `https://extension-bundles.intentic.invalid/`;

// Every revision of one extension on one sandbox shares this prefix, which is what storing a new one prunes by.
const prefixOf = (sandboxId: string, handle: string): string => new URL(`${encodeURIComponent(sandboxId)}/${encodeURIComponent(handle)}/`, KEY_ORIGIN).href;

export const bundleKeyOf = (sandboxId: string, handle: string, revision: BundleRevision): string =>
    new URL(`${revision.kind}/${encodeURIComponent(revision.value)}`, prefixOf(sandboxId, handle)).href;

// The parts of Cache Storage this uses (a `CacheStorage` is one), so a suite can hand in its own.
export interface BundleEntries {
    match(key: string): Promise<Response | undefined>;
    put(key: string, response: Response): Promise<void>;
    delete(key: string | Request): Promise<boolean>;
    keys(): Promise<readonly Request[]>;
}
export interface BundleStorage {
    open(name: string): Promise<BundleEntries>;
}

// Cache Storage and SubtleCrypto exist only in a secure context, and reading `caches` throws where storage is denied (an
// opaque origin, some webviews): either missing turns the cache off, never the load.
const browserBundleStorage = (): BundleStorage | undefined => {
    try {
        return `caches` in globalThis && `subtle` in globalThis.crypto ? globalThis.caches : undefined;
    } catch {
        // allow(silent-catch): storage denied to this page; every bundle is fetched, as without a cache
        return undefined;
    }
};

// Whether bytes hashing to `hash` can be this revision. A checkout's build says its own hash; a commit's bytes have no
// hash on the list to hold them to, so a pinned entry is only stored once the list confirms the commit (BundlePass.settle).
const fits = (revision: BundleRevision, hash: string): boolean => revision.kind !== `dev` || hash.startsWith(revision.value);

// Stored beside each source: what it hashed to when it went in, which it must hash to again to come out.
const HASH_HEADER = `x-intentic-bundle-sha256`;

// The source stored under `key` if it is whole and is this revision; an entry that is neither is deleted.
const readEntry = async (storage: BundleStorage, key: string, revision: BundleRevision): Promise<string | undefined> => {
    const cache = await storage.open(EXTENSION_BUNDLE_CACHE);
    const response = await cache.match(key);
    if (response === undefined) {
        return undefined;
    }
    const source = await response.text();
    const hash = await sha256Hex(source);
    if (hash === response.headers.get(HASH_HEADER) && fits(revision, hash)) {
        return source;
    }
    await cache.delete(key);
    return undefined;
};

// Stores a fetched source under its revision, and drops every other revision of the same extension on the same sandbox.
// A checkout's build that does not hash to the revision the list named (a rebuild landed between the two reads) is not
// stored at all.
const writeEntry = async (storage: BundleStorage, sandboxId: string, handle: string, revision: BundleRevision, source: string): Promise<void> => {
    const hash = await sha256Hex(source);
    if (!fits(revision, hash)) {
        return;
    }
    const cache = await storage.open(EXTENSION_BUNDLE_CACHE);
    const key = bundleKeyOf(sandboxId, handle, revision);
    await cache.put(key, new Response(source, { headers: { "content-type": `text/javascript; charset=utf-8`, [HASH_HEADER]: hash } }));
    const prefix = prefixOf(sandboxId, handle);
    for (const request of await cache.keys()) {
        if (request.url.startsWith(prefix) && request.url !== key) {
            await cache.delete(request);
        }
    }
};

// What a row says about which bytes the daemon serves for it. A pinned entry is stored only when the list read after
// the fetch says the same as the one read before it: an update, a revert or a dev pointer landing in between moves the
// commit, the kept previous commit or the pointer.
const servedIdentity = (summary: ServedSummary): string =>
    JSON.stringify([exactRevisionOf(summary), summary.manifest.entry, summary.previous?.ref, summary.dev?.path, summary.dev?.conversation, summary.dev?.held]);

export interface CachedBundle {
    readonly key: string;
    readonly source: string;
}

// One load pass's use of the cache, bound to the sandbox its list came from. `current` says whether that sandbox is
// still the one this pass loads for; once it is not, the pass neither reads nor writes.
export interface BundlePass {
    // The cached source of this row's exact revision, verified, or undefined.
    cached(summary: ServedSummary): Promise<CachedBundle | undefined>;
    drop(entry: CachedBundle): Promise<void>;
    // A source fetched for this row that linked and imported: kept now if it is a checkout's build (its hash proves it),
    // held for `settle` if it is a commit's.
    fetched(summary: ServedSummary, source: string): void;
    // Re-reads the list once and stores each held source whose row still names the same bundle.
    settle(relist: () => Promise<readonly ServedSummary[]>): Promise<void>;
}

const NO_PASS: BundlePass = {
    cached: async () => undefined,
    drop: async () => undefined,
    fetched: () => undefined,
    settle: async () => undefined,
};

export const bundlePass = (sandboxId: string | undefined, current: () => boolean, storage: BundleStorage | undefined = browserBundleStorage()): BundlePass => {
    if (sandboxId === undefined || storage === undefined) {
        return NO_PASS;
    }
    const held: { readonly summary: ServedSummary; readonly revision: BundleRevision; readonly source: string }[] = [];
    const revisionOf = (summary: ServedSummary): BundleRevision | undefined => (current() ? exactRevisionOf(summary) : undefined);
    const store = async (summary: ServedSummary, revision: BundleRevision, source: string): Promise<void> => {
        try {
            await writeEntry(storage, sandboxId, summary.id, revision, source);
        } catch {
            // allow(silent-catch): storage full or refused; the next load fetches the bundle again, which is all a missing entry costs
        }
    };
    return {
        cached: async (summary) => {
            const revision = revisionOf(summary);
            if (revision === undefined) {
                return undefined;
            }
            const key = bundleKeyOf(sandboxId, summary.id, revision);
            try {
                const source = await readEntry(storage, key, revision);
                return source === undefined || !current() ? undefined : { key, source };
            } catch {
                // allow(silent-catch): storage refused the read; the bundle is fetched, as without a cache
                return undefined;
            }
        },
        drop: async (entry) => {
            try {
                await (await storage.open(EXTENSION_BUNDLE_CACHE)).delete(entry.key);
            } catch {
                // allow(silent-catch): storage refused the delete; the entry fails its check again next load and is fetched past again
            }
        },
        fetched: (summary, source) => {
            const revision = revisionOf(summary);
            if (revision?.kind === `dev`) {
                void store(summary, revision, source);
            } else if (revision !== undefined) {
                held.push({ summary, revision, source });
            }
        },
        settle: async (relist) => {
            if (held.length === 0 || !current()) {
                return;
            }
            let listed: readonly ServedSummary[];
            try {
                listed = await relist();
            } catch {
                // allow(silent-catch): no confirming list, so nothing is stored; the next load fetches these bundles again
                return;
            }
            for (const { summary, revision, source } of held.splice(0)) {
                const now = listed.find((entry) => entry.id === summary.id);
                if (now !== undefined && current() && servedIdentity(now) === servedIdentity(summary)) {
                    await store(summary, revision, source);
                }
            }
        },
    };
};

// What a source came to: the module it exported, or why it would not link against this host.
export type Linked<M> = { readonly module: M } | { readonly unlinked: string };

// The module a cached copy imports to, or undefined when it does not link or import.
const cachedModule = async <M>(hit: CachedBundle, link: (source: string) => Promise<Linked<M>>): Promise<{ readonly module: M } | undefined> => {
    try {
        const linked = await link(hit.source);
        return `module` in linked ? linked : undefined;
    } catch {
        // allow(silent-catch): the copy is dropped and the bundle fetched fresh, whose own failure is the one reported
        return undefined;
    }
};

// A daemon-served extension's code: the cached copy of its exact revision when that links and imports, else a fresh
// fetch. A cached copy that fails either is deleted and fetched past once, so a bad entry can never stick; a fresh one
// that links and imports is handed to the pass to keep.
export const bundleModule = async <M>(
    pass: BundlePass,
    summary: ServedSummary,
    fetchSource: () => Promise<string>,
    link: (source: string) => Promise<Linked<M>>,
): Promise<Linked<M>> => {
    const hit = await pass.cached(summary);
    if (hit !== undefined) {
        const linked = await cachedModule(hit, link);
        if (linked !== undefined) {
            return linked;
        }
        await pass.drop(hit);
    }
    const source = await fetchSource();
    const linked = await link(source);
    if (`module` in linked) {
        pass.fetched(summary, source);
    }
    return linked;
};
