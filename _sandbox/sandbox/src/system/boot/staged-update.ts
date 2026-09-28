import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type StagedUpdate, StagedUpdateSchema, type UpdateOutcome, UpdateOutcomeSchema } from "@intentic/sandbox-contract";
import type { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";

// What the host says about this sandbox's version, in the files it writes onto /history. Advisory only: the update,
// the swap and going back are the host's, and each marker is only how the sandbox and its owner hear of them.

// Whether an update is already downloaded, reported by the only thing that can know: `ic sandbox prepare` writes this
// marker when it finishes, and removes it once a swap consumes it. The swap re-derives everything from the host record
// and refuses the fast path if anything drifted.
// Written by ic (_sandbox/ic/src/sandbox/staged.rs), its plan the pre-flight's line verbatim; declared so its shape is
// frozen like every other stored file, and a change to it that an older marker would not satisfy fails the typecheck.
// Not the boot step's to look for: ic writes and removes it.
export const stagedUpdateDocument = defineDocument({ root: "history", path: "update-staged.json", boot: false, schema: StagedUpdateSchema });

// What the host last did about this sandbox's version: an update that took, one it gave up on, and until when the
// version before stays ready. Written by ic (_sandbox/ic/src/sandbox/outcome.rs) on the volume both containers share,
// so the version that ends up running reads what happened to the other one. Declared for the same reasons as the
// staged marker, and like it never written here.
export const updateOutcomeDocument = defineDocument({ root: "history", path: "update-outcome.json", boot: false, schema: UpdateOutcomeSchema });

// One of the host's markers, or undefined. Never throws: a missing, unreadable, or newer-format marker all read as
// nothing said, since each is only ever advice.
const hostMarker = async <T>(historyRoot: string, path: string, schema: z.ZodType<T>): Promise<T | undefined> => {
    try {
        const parsed = schema.safeParse(JSON.parse(await readFile(join(historyRoot, path), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};

// What the host left for us, or undefined when nothing is staged.
export const stagedUpdate = (historyRoot: string): Promise<StagedUpdate | undefined> => hostMarker(historyRoot, stagedUpdateDocument.path, StagedUpdateSchema);

// The host's last word on this sandbox's version, or undefined when it has said nothing this build can read.
export const updateOutcome = (historyRoot: string): Promise<UpdateOutcome | undefined> => hostMarker(historyRoot, updateOutcomeDocument.path, UpdateOutcomeSchema);
