import { z } from "zod";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

/* WHICH OF THE ROUTES AN EXTENSION DECLARED IT ACTUALLY CALLS (<workspace>/.intentic/records/extension-usage.json),
 * keyed by the manifest-derived extension id and then by the DECLARED ENTRY, verbatim.
 *
 * `permissions.sandbox` is the one part of a manifest that is a promise about behaviour rather than a
 * description of it, and until now nothing anywhere could tell whether the promise was tight. An author copies a
 * list from an example, keeps the two routes they need and three they don't, and every owner who installs it is
 * asked to approve reach that was never used. The gate that refuses undeclared routes already sees every call,
 * this is the same observation, kept.
 *
 * KEYED BY THE DECLARED ENTRY, not by the concrete path that was called. Three reasons, and the first is the
 * important one: the entry is the line an author would delete, so a count against it is directly actionable,
 * while a count against `/workspace/file?path=…/secrets.env` is a log of what the owner was doing. It also keeps
 * the file bounded by the manifest rather than by usage, and it survives the query strings and path segments
 * that make concrete paths unbounded.
 *
 * COUNTS AND A LAST-SEEN, nothing else. No per-call record, because the question this answers is "is this
 * permission earned?" and that needs a number and a date; anything finer would be a surveillance log of the
 * owner's session that happens to be indexed by extension. */

const RouteUsageSchema = z.object({
    calls: z.number().int().nonnegative(),
    // ISO-8601. Read as "this permission was still in use recently", which is what makes an old date a question
    // worth asking rather than a fact worth storing.
    last: z.string().min(1),
});
export type RouteUsage = z.infer<typeof RouteUsageSchema>;

const FileSchema = z.record(z.string(), z.record(z.string(), RouteUsageSchema));
type UsageFile = z.infer<typeof FileSchema>;

// Memoized per root for the reason extension-settings.ts spells out: the write queue lives on the file object,
// so a fresh one per call would let two reports read the same map and the second erase the first's counts.
const files = new Map<string, JsonFile<UsageFile>>();

const usageFile = (root: string): JsonFile<UsageFile> => {
    const path = statePath(root, ".intentic/records/extension-usage.json");
    const existing = files.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<UsageFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });
    files.set(path, file);
    return file;
};

export const readExtensionUsage = async (root: string): Promise<UsageFile> => usageFile(root).read();

/* Add a batch of calls. `declared` is the extension's CURRENT permissions list and acts as the filter in both
 * directions: an entry the manifest no longer names is dropped from the batch and swept from what was already
 * stored. Without that sweep the file would accumulate every route any version of the extension ever declared,
 * and a permission that was removed months ago would keep answering "used 4,000 times" to a question about the
 * extension that is installed now. */
export const recordExtensionUsage = async (
    root: string,
    extensionId: string,
    declared: readonly string[],
    batch: Record<string, number>,
    at: string,
): Promise<void> => {
    const allowed = new Set(declared);
    await usageFile(root).update((all) => {
        const before = all[extensionId] ?? {};
        const next: Record<string, RouteUsage> = {};
        for (const entry of allowed) {
            const previous = before[entry];
            const added = batch[entry] ?? 0;
            if (previous === undefined && added === 0) {
                continue;
            }
            next[entry] = { calls: (previous?.calls ?? 0) + added, last: added > 0 ? at : (previous?.last ?? at) };
        }
        return { ...all, [extensionId]: next };
    });
};
