import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Usage of each declared sandbox route (.intentic/records/extension-usage.json), by extension id then declared entry.
// Answers whether a permissions.sandbox entry is used; keyed by the entry, not the path, so the file stays bounded.
// Stores only a count and a last-seen date, nothing finer that would amount to a session log.

const RouteUsageSchema = z.object({
    calls: z.number().int().nonnegative(),
    // ISO-8601; an old date is a question to ask, not a fact to store.
    last: z.string().min(1),
});
export type RouteUsage = z.infer<typeof RouteUsageSchema>;

const ExtensionUsageSchema = z.record(z.string(), RouteUsageSchema);
type UsageFile = Record<string, z.infer<typeof ExtensionUsageSchema>>;

export const extensionUsageDocument = defineDocument({
    path: stateRelPath(".intentic/records/extension-usage.json"),
    schema: ExtensionUsageSchema,
    granularity: "record",
});

// A handle per call: every handle on one path shares its write queue (queueOnFile), so a concurrent report is kept.
const usageFile = (root: string): JsonFile<UsageFile> => openDocument(extensionUsageDocument, join(root, extensionUsageDocument.path), { fallback: () => ({}) });

export const readExtensionUsage = async (root: string): Promise<UsageFile> => usageFile(root).read();

// Drops one extension's counts: the ledger answers "is this permission earned", and a removed extension has no
// permissions for old counts to speak about.
export const forgetExtensionUsage = async (root: string, extensionId: string): Promise<void> => {
    await usageFile(root).update((all) => {
        if (!(extensionId in all)) {
            // By reference, so jsonFile skips the write when there is nothing to drop.
            return all;
        }
        const { [extensionId]: _dropped, ...rest } = all;
        return rest;
    });
};

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
