import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { z } from "zod";
import { version } from "../version.js";
import { stateRelPath } from "../state-paths.js";
import { defineDocument } from "./evolution/documents.js";

// Stamp of the newest intentic that ran this workspace, recorded by the boot step before any store opens and moved
// only forward: its release version, the digest of the conversions it ran (store/evolution/documents.ts), and the
// conversion count builds before the digest compared. manifest-problems.ts explains a post-rollback schema rejection as
// a newer file rather than a broken one; json-file.ts refuses to set such a file aside; the state plan reports a
// downgrade when the stamp names a newer release than its own. Plain read/write, not jsonFile: daemon-only state,
// written at most once per boot.

// Declared for its shape, which the shape generator freezes; its reader below takes each field only when it is there.
// A stamp from before the digest carries `version` and `engine`, and one from before the engine only `version`.
const NewestRunSchema = z.object({
    version: z.string().optional(),
    // Read by builds before the digest, which report a downgrade when it exceeds their own count: so it never goes down.
    engine: z.number().optional(),
    digest: z.string().optional(),
});
export const newestRunDocument = defineDocument({ path: stateRelPath(".intentic/local/newest-run.json"), schema: NewestRunSchema });

// Undefined until recordNewestRun runs; after that, the newest version seen.
let newest: string | undefined;
// The newest conversion count recorded here, undefined before any engine ran.
let newestEngine: number | undefined;
// The conversion digest the newest run recorded, undefined before any build that wrote one.
let newestDigest: string | undefined;

export const newestRunVersion = (): string | undefined => newest;

export const newestRunEngine = (): number | undefined => newestEngine;

export const newestRunDigest = (): string | undefined => newestDigest;

// Whether a newer intentic has run this workspace: its files may hold what this build cannot read, and are never
// moved aside or written over whole by it.
export const newerBuildRan = (running: string = version): boolean => newest !== undefined && isNewer(newest, running);

// Whether this build is a rollback over these files: the stamp names a newer release than it. Decided by version alone,
// so a stamp from before the digest reads the same as one after, and a release that retires a document or a step is no
// downgrade of the one before it. A dev build names no release and is never told it is older; a stamp naming no version
// (one holding only an engine count) names no release either, so it reports none.
export const isDowngrade = (running: string = version): boolean => running !== DEV_VERSION && newerBuildRan(running);

export interface NewestRunOptions {
    // The running build's conversion count, stamped beside its version for the builds that still compare it.
    readonly engine?: number;
    // The running build's conversion digest, stamped beside its version.
    readonly digest?: string;
    // False for a daemon that may not converge this workspace (a guest): it learns the stamp and writes nothing.
    readonly write?: boolean;
}

export const recordNewestRun = async (workspaceRoot: string, running: string = version, options: NewestRunOptions = {}): Promise<void> => {
    const path = join(workspaceRoot, newestRunDocument.path);
    let recorded: z.infer<typeof NewestRunSchema> = {};
    try {
        const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> | undefined;
        recorded = {
            ...(typeof raw?.["version"] === "string" ? { version: raw["version"] } : {}),
            ...(typeof raw?.["engine"] === "number" ? { engine: raw["engine"] } : {}),
            ...(typeof raw?.["digest"] === "string" ? { digest: raw["digest"] } : {}),
        };
    } catch {
        // Absent or unreadable both read as no run recorded; re-established below.
    }
    newest = recorded.version;
    newestEngine = recorded.engine;
    newestDigest = recorded.digest;
    if (options.write === false || running === DEV_VERSION || (recorded.version !== undefined && !isNewer(running, recorded.version))) {
        return;
    }
    newest = running;
    newestEngine = Math.max(recorded.engine ?? 0, options.engine ?? 0);
    newestDigest = options.digest;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify({ version: running, engine: newestEngine, ...(newestDigest === undefined ? {} : { digest: newestDigest }) }, undefined, 2)}\n`);
    } catch {
        // A workspace that cannot be written loses nothing but the better sentence.
    }
};

// Test seam, like clearManifestProblems: the stamp cache is module state.
export const clearNewestRun = (): void => {
    newest = undefined;
    newestEngine = undefined;
    newestDigest = undefined;
};
