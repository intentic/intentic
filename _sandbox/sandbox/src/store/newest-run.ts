import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNewer } from "@intentic/sandbox-contract";
import { version } from "../version.js";
import { statePath } from "../state-paths.js";

// Stamp of the newest intentic that ran this workspace and the newest conversion engine it ran, recorded by the boot
// step before any store opens and moved only forward. manifest-problems.ts explains a post-rollback schema rejection
// as a newer file rather than a broken one; json-file.ts refuses to set such a file aside; the state plan reports a
// downgrade when the engine that converted these files is newer than its own. Plain read/write, not jsonFile:
// daemon-only state, written at most once per boot.

// Undefined until recordNewestRun runs; after that, the newest version seen.
let newest: string | undefined;
// The newest conversion engine epoch recorded here (store/evolution/documents.ts), undefined before any engine ran.
let newestEngine: number | undefined;

export const newestRunVersion = (): string | undefined => newest;

export const newestRunEngine = (): number | undefined => newestEngine;

// Whether a newer intentic has run this workspace: its files may hold what this build cannot read, and are never
// moved aside or written over whole by it.
export const newerBuildRan = (running: string = version): boolean => newest !== undefined && isNewer(newest, running);

export interface NewestRunOptions {
    // The running build's engine epoch, stamped beside its version.
    readonly engine?: number;
    // False for a daemon that may not converge this workspace (a guest): it learns the stamp and writes nothing.
    readonly write?: boolean;
}

export const recordNewestRun = async (workspaceRoot: string, running: string = version, options: NewestRunOptions = {}): Promise<void> => {
    const path = statePath(workspaceRoot, ".intentic/local/newest-run.json");
    let recorded: string | undefined;
    let recordedEngine: number | undefined;
    try {
        const raw = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; engine?: unknown } | undefined;
        recorded = typeof raw?.version === "string" ? raw.version : undefined;
        recordedEngine = typeof raw?.engine === "number" ? raw.engine : undefined;
    } catch {
        // Absent or unreadable both read as no run recorded; re-established below.
    }
    newest = recorded;
    newestEngine = recordedEngine;
    if (options.write === false || running === "0.0.0" || (recorded !== undefined && !isNewer(running, recorded))) {
        return;
    }
    newest = running;
    newestEngine = Math.max(recordedEngine ?? 0, options.engine ?? 0);
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify({ version: running, engine: newestEngine }, undefined, 2)}\n`);
    } catch {
        // A workspace that cannot be written loses nothing but the better sentence.
    }
};

// Test seam, like clearManifestProblems: the stamp cache is module state.
export const clearNewestRun = (): void => {
    newest = undefined;
    newestEngine = undefined;
};
