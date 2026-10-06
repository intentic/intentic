import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { cacheFile } from "../store/open-document.js";
import { catalogPath, exitDir } from "./exit-paths.js";

// A provider's catalog cached off the network (`catalog-<provider>.json`, `{ at, <key>: [...] }`), shared by every
// exit provider that fetches one. Read through the entry schema, never cast: a file a cut write or another build left
// reads as no cache, so it is refetched rather than handed on half-formed. Written atomically, 0600 in the 0700 exit
// directory.

export interface CachedCatalog<T> {
    // Undefined when nothing is cached and the network did not answer: the caller's own fallback stands in.
    readonly entries: readonly T[] | undefined;
    // Fresh from the network or a cache inside its TTL; false for a stale cache or nothing at all.
    readonly live: boolean;
}

// The file as stored: when it was fetched, and the list under its provider's key.
type Stored<K extends string, T> = { readonly at: number } & { readonly [P in K]: readonly T[] };

export const providerCatalog = async <K extends string, T>(
    provider: string,
    // The key the list is stored under, kept per provider so caches written before this module still read.
    key: K,
    entry: z.ZodType<T>,
    ttlMs: number,
    fetchFresh: () => Promise<readonly T[] | undefined>,
): Promise<CachedCatalog<T>> => {
    const shape = z.object({ at: z.number(), [key]: z.array(entry) });
    const file = cacheFile(catalogPath(provider), {
        // SAFETY: parsed by `shape`, which is Stored<K, T> spelled with a computed key zod cannot type.
        parse: (raw) => shape.safeParse(raw).data as Stored<K, T> | undefined,
        fallback: () => undefined,
        mode: 0o600,
    });
    const cached = await file.read();
    if (cached !== undefined && Date.now() - cached.at < ttlMs) {
        return { entries: cached[key], live: true };
    }
    const fresh = await fetchFresh();
    if (fresh === undefined) {
        // A cache past its TTL still beats a baked list: it's this network, only hours stale.
        return { entries: cached?.[key], live: false };
    }
    // The cache is best-effort: entries fetched but not kept are fetched again next time, and are returned either way.
    // allow(silent-catch): a cache directory that cannot be made only means the write below fails the same quiet way
    await mkdir(exitDir(), { recursive: true, mode: 0o700 }).catch(() => undefined);
    // SAFETY: Stored<K, T> itself, spelled with a computed key TypeScript widens to an index signature.
    // allow(silent-catch): an unwritten cache costs one more fetch next time, never this answer
    await file.update(() => ({ at: Date.now(), [key]: fresh }) as Stored<K, T>).catch(() => undefined);
    return { entries: fresh, live: true };
};
