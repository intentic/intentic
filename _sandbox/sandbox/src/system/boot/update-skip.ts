import { join } from "node:path";
import { isNewer } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// The release the owner asked not to be offered (POST /system/update/skip), typically one this sandbox already tried and
// went back from. Kept on the history volume beside the host's own update markers: it is about which version runs on
// this machine, so it stays with the machine rather than travelling in a bundle. /info reads it back as
// `skippedVersion`, and offers no update while the newest release is the skipped one.
const SkippedUpdateSchema = z.object({
    // Absent once the owner asked for the newest release to be offered again.
    version: z.string().optional(),
});
export const skippedUpdateDocument = defineDocument({ root: "history", path: "update-skipped.json", schema: SkippedUpdateSchema });

export interface UpdateSkip {
    readonly skipped: () => Promise<string | undefined>;
    // Null offers the newest release again.
    readonly skip: (version: string | null) => Promise<void>;
}

// Opened wherever it is needed: every handle on the path shares its write queue.
export const fileUpdateSkip = (historyRoot: string): UpdateSkip => {
    const file = openDocument(skippedUpdateDocument, join(historyRoot, skippedUpdateDocument.path), { fallback: () => ({}) });
    return {
        skipped: async () => (await file.read()).version,
        // Stored as release versions are compared (version-check.ts): without the tag's `v`.
        skip: async (version) => {
            await file.update(() => (version === null ? {} : { version: version.replace(/^v/, "") }));
        },
    };
};

// Whether `latest` is an update worth offering over `running`: newer, and not the release the owner skipped. A release
// newer than the skipped one is offered as usual.
export const updateOffered = (latest: string, running: string, skipped: string | undefined): boolean => isNewer(latest, running) && latest !== skipped;
