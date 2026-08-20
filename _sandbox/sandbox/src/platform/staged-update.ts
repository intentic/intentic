import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type StagedUpdate, StagedUpdateSchema } from "@intentic/sandbox-contract";

/* AN UPDATE THAT IS ALREADY DOWNLOADED, as reported by the only thing that can know it.
 *
 * The daemon can see that a newer release EXISTS (version-check.ts asks GitHub) and it cannot see whether that
 * release is on this machine yet, it holds no Docker socket, and the host's channel record lives under the
 * user's home, which the container never mounts. That gap is why the update card quoted "a few minutes" for
 * every update: minutes is what a download costs, and the card had no way to tell a download that has already
 * happened from one that has not. The restart underneath it is seconds either way.
 *
 * So `ic sandbox prepare` writes this file when it finishes pulling and building, and removes it when a swap
 * consumes it. It sits on the /history volume rather than in the workspace: /history is daemon-owned and
 * outside the agent's /work mount, the same placement the activity and usage ledgers get, which keeps "an
 * update is ready to apply" a statement the HOST made rather than one anything inside the sandbox can assert.
 *
 * ADVISORY, and only ever that. It drives one sentence of card copy and the label on a button; nothing here
 * decides what gets installed. The swap itself re-derives everything from the host record, which channel was
 * staged, which recipe it was built with, whether the sandbox has moved since, and refuses the fast path if
 * any of it has drifted. A stale or absent marker costs a user nothing worse than the update they already had.
 *
 * Read per request rather than cached: it is two hundred bytes on a local volume, it changes from OUTSIDE this
 * process, and a cache would put the card minutes behind the download it is describing, which is the exact
 * failure this file exists to remove. */

const MARKER_FILE = "update-staged.json";

/// What the host left for us, or undefined for the ordinary case where nothing is staged. Never throws: an
/// absent file, an unreadable one, and one written by a newer `ic` in a shape this build does not know all
/// mean the same thing to every reader, no update is known to be waiting, so the card reads as it always did.
export const stagedUpdate = async (historyRoot: string): Promise<StagedUpdate | undefined> => {
    try {
        const parsed = StagedUpdateSchema.safeParse(JSON.parse(await readFile(join(historyRoot, MARKER_FILE), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};
