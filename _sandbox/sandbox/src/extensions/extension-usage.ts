import { z } from "zod";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/layout/state-paths.js";

// Usage of each declared sandbox route (.intentic/records/extension-usage.json), by extension id then declared entry.
// Answers whether a permissions.sandbox entry is used; keyed by the entry, not the path, so the file stays bounded.
// Stores only a count and a last-seen date, nothing finer that would amount to a session log.

const RouteUsageSchema = z.object({
    calls: z.number().int().nonnegative(),
    // ISO-8601; an old date is a question to ask, not a fact to store.
    last: z.string().min(1),
});
export type RouteUsage = z.infer<typeof RouteUsageSchema>;

const FileSchema = z.record(z.string(), z.record(z.string(), RouteUsageSchema));
type UsageFile = z.infer<typeof FileSchema>;

// Memoized per root: the write queue lives on the file object; a fresh instance would drop a concurrent report.
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

// Adds a batch of calls; `declared` (the extension's current permissions) filters both the batch and what's stored.
// An entry the manifest no longer names is swept out, so a removed permission stops answering for old counts.
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
