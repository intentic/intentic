import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type StagedUpdate, StagedUpdateSchema } from "@intentic/sandbox-contract";

// Whether an update is already downloaded, reported by the only thing that can know: `ic sandbox prepare` writes this
// marker on /history when it finishes, and removes it once a swap consumes it. Advisory only: the swap re-derives
// everything from the host record and refuses the fast path if anything drifted.

const MARKER_FILE = "update-staged.json";

// What the host left for us, or undefined when nothing is staged. Never throws: a missing, unreadable, or newer-format
// marker all read as "nothing known to be waiting".
export const stagedUpdate = async (historyRoot: string): Promise<StagedUpdate | undefined> => {
    try {
        const parsed = StagedUpdateSchema.safeParse(JSON.parse(await readFile(join(historyRoot, MARKER_FILE), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};
