import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNewer } from "@intentic/sandbox-contract";
import { version } from "../version.js";
import { statePath } from "../workspace/layout/state-paths.js";

// Stamp of the newest intentic that ran this workspace, recorded at boot and moved only forward, so
// manifest-problems.ts can explain a post-rollback schema rejection as a newer file rather than a broken one. Plain
// read/write, not jsonFile: daemon-only state, written at most once per boot.

// Undefined until recordNewestRun runs; after that, the newest version seen.
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
        // Absent or unreadable both read as no run recorded; re-established below.
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
