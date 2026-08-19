import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNewer } from "@intentic/sandbox-contract";
import { version } from "../version.js";
import { statePath } from "../workspace/state-paths.js";

/* THE NEWEST INTENTIC THAT EVER RAN THIS WORKSPACE — one small stamp, `.intentic/local/newest-run.json`, recorded at
 * boot and moved only FORWARD.
 *
 * It exists for exactly one sentence. After `ic sandbox rollback`, every manifest the newer build wrote reads
 * — through the loose parse — as "does not match what this build expects", which is the same words a
 * hand-mangled file earns, and the repair they suggest (fix the file) is wrong for this case: the file is
 * fine, the daemon is older than it. The stamp is what lets the problem report say so instead
 * (manifest-problems.ts): recognition of what happened, in the user's terms, and nothing more. Deliberately NO
 * migration and no version-conditional reading anywhere — the file either parses or it does not, exactly as
 * before; only the explanation improves.
 *
 * Forward-only is the load-bearing property: a rollback must not lower the stamp, or the evidence of the
 * newer run would be erased by precisely the event it exists to explain. A dev build (the 0.0.0 sentinel)
 * records nothing and outranks nothing.
 *
 * Plain read/write rather than the jsonFile substrate: this is daemon-written machine state (never surfaced
 * as a repair job — isReportedManifest excludes it), it is written once per boot at most, and the worst a torn
 * read can cost is one boot's worth of the better sentence. */

// The stamp as read at boot — undefined until recordNewestRun ran, and after it the newest version known.
let newest: string | undefined;

export const newestRunVersion = (): string | undefined => newest;

export const recordNewestRun = async (workspaceRoot: string, running: string = version): Promise<void> => {
    const path = statePath(workspaceRoot, ".intentic/local/newest-run.json");
    let recorded: string | undefined;
    try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        const value = (raw as { version?: unknown } | undefined)?.version;
        recorded = typeof value === "string" ? value : undefined;
    } catch {
        // Absent or unreadable both read as "no run recorded" — the stamp re-establishes itself below.
    }
    newest = recorded;
    if (running === "0.0.0" || (recorded !== undefined && !isNewer(running, recorded))) {
        return;
    }
    newest = running;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify({ version: running }, undefined, 2)}\n`);
    } catch {
        // A workspace that cannot be written loses nothing but the better sentence.
    }
};

// Test seam, like clearManifestProblems: the stamp cache is module state.
export const clearNewestRun = (): void => {
    newest = undefined;
};
