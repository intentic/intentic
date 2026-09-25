import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type StagedUpdate, StagedUpdateSchema } from "@intentic/sandbox-contract";
import { defineDocument } from "../../store/evolution/documents.js";

// Whether an update is already downloaded, reported by the only thing that can know: `ic sandbox prepare` writes this
// marker on /history when it finishes, and removes it once a swap consumes it. Advisory only: the swap re-derives
// everything from the host record and refuses the fast path if anything drifted.

// Written by ic (_sandbox/ic/src/sandbox/staged.rs), its plan the pre-flight's line verbatim; declared so its shape is
// frozen like every other stored file, and a change to it that an older marker would not satisfy fails the typecheck.
// Not the boot step's to look for: ic writes and removes it.
export const stagedUpdateDocument = defineDocument({ root: "history", path: "update-staged.json", boot: false, schema: StagedUpdateSchema });

// What the host left for us, or undefined when nothing is staged. Never throws: a missing, unreadable, or newer-format
// marker all read as "nothing known to be waiting".
export const stagedUpdate = async (historyRoot: string): Promise<StagedUpdate | undefined> => {
    try {
        const parsed = StagedUpdateSchema.safeParse(JSON.parse(await readFile(join(historyRoot, stagedUpdateDocument.path), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};
