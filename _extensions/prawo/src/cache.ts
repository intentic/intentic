import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";

/* WHAT WAS FETCHED, KEPT IN THE WORKSPACE'S CACHE (extensionCacheDir, under .intentic/local/cache/): one JSON file per
   act, text, search and ruling. A published text never changes, so it is kept for good and read without asking the
   network; metadata and searches are refreshed after a while. When a refresh fails (no network, the source down) the
   copy on disk answers, marked stale, so a lookup made once keeps working offline. */

export interface Cached<T> {
    readonly value: T;
    readonly savedAt: string;
    // Why a fresh copy could not be had, when this one is served in its place.
    readonly stale?: string | undefined;
}

export interface Freshness {
    // How long a copy answers without asking the source again; absent for content that never changes.
    readonly maxAgeMs?: number | undefined;
    // Ask the source even when the copy is young enough.
    readonly refresh?: boolean | undefined;
}

const EnvelopeSchema = z.object({ savedAt: z.string(), value: z.unknown() });

// A key as a file name: "acts/DU/1960/168" is acts/DU-1960-168.json.
const fileOf = (root: string, key: string): string => {
    const [group = "", ...rest] = key.split("/");
    return join(root, group, `${rest.join("-").replaceAll(/[^\w.-]/gu, "_")}.json`);
};

export class Cache {
    constructor(
        readonly root: string,
        private readonly now: () => Date,
    ) {}

    async read<T>(key: string, schema: z.ZodType<T>): Promise<Cached<T> | undefined> {
        const raw = await readFile(fileOf(this.root, key), "utf8").catch(undefinedIfMissing);
        if (raw === undefined) {
            return undefined;
        }
        const envelope = EnvelopeSchema.parse(JSON.parse(raw));
        // A copy an older version wrote in another shape is simply not there.
        const value = schema.safeParse(envelope.value);
        return value.success ? { value: value.data, savedAt: envelope.savedAt } : undefined;
    }

    async write<T>(key: string, value: T): Promise<Cached<T>> {
        const savedAt = this.now().toISOString();
        await writeFileAtomic(fileOf(this.root, key), JSON.stringify({ savedAt, value }));
        return { value, savedAt };
    }

    // The copy when it is fresh enough, else the source's answer, saved; the copy again, marked stale, when the source
    // cannot be reached.
    async through<T>(key: string, schema: z.ZodType<T>, load: () => Promise<T>, freshness: Freshness = {}): Promise<Cached<T>> {
        const cached = await this.read(key, schema);
        const age = cached === undefined ? Number.POSITIVE_INFINITY : this.now().getTime() - Date.parse(cached.savedAt);
        if (cached !== undefined && freshness.refresh !== true && (freshness.maxAgeMs === undefined || age < freshness.maxAgeMs)) {
            return cached;
        }
        try {
            return await this.write(key, await load());
        } catch (error) {
            if (cached === undefined) {
                throw error;
            }
            return { ...cached, stale: errorMessage(error) };
        }
    }
}
