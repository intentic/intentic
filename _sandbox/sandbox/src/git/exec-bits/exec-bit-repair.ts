import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import type { Services } from "../../composition.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import { executableOnDiskPaths, markExecutable } from "../changes/changes-index.js";

// ONE-TIME REPAIR OF EXECUTABLE BITS a repository stored as 100644. Every daemon git call reads modes with
// core.fileMode=false (@intentic/base/git), and until 2026-11 a land's version commit re-read its paths from disk under
// that setting (changes/changes-index.ts commitOnly), so a script made executable in the main tree was committed 100644, and every
// checkout cut from that commit ran it as "Permission denied" (30 conversations on one sandbox, build-web.sh alone in 16).
// Staging records a bit a file gained now, but a file already stored 100644 that nobody edits is never staged again.
//
// So once per repository: every tracked file executable on disk and stored 100644 is recorded +x in the main tree's
// index, an ordinary staged change the owner sees in Changes and commits with the rest. Only a file that opens with `#!`:
// a sync or an upload can leave a whole tree executable, and a repair that marks every file +x is worse than the fault.
// The marker lives in the repository's own git dir, so a repository cloned again is looked at again.

const MARKER = "intentic-exec-bits-repaired";

// Whether a file starts with `#!`: what makes an executable bit on it a script's, rather than a sync's leftover.
const opensWithShebang = async (path: string): Promise<boolean> => {
    // allow(silent-catch): a file gone or unreadable since the diff named it is no script to mark.
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) {
        return false;
    }
    try {
        const head = Buffer.alloc(2);
        const { bytesRead } = await handle.read(head, 0, 2, 0);
        return bytesRead === 2 && head.toString("latin1") === "#!";
    } finally {
        await handle.close();
    }
};

/** Records +x for `dir`'s scripts stored 100644, once; answers the paths it marked (empty where it had run before). */
export const repairExecutableBits = async (dir: string, git: GitRunner = defaultGit): Promise<readonly string[]> => {
    const marker = (await git(dir, ["rev-parse", "--git-path", MARKER])).stdout.trim();
    const markerPath = marker.startsWith("/") ? marker : join(dir, marker);
    if (await pathExists(markerPath)) {
        return [];
    }
    const candidates = await executableOnDiskPaths(dir, git);
    const scripts = (await Promise.all(candidates.map(async (path) => ((await opensWithShebang(join(dir, path))) ? [path] : [])))).flat();
    await markExecutable(dir, scripts, git);
    await writeFile(markerPath, `${new Date().toISOString()} ${scripts.length}\n`);
    return scripts;
};

/** Every main-tree repository, each under its repo lock so no land writes the index meanwhile. Never throws: a repo it
 *  could not repair is logged and looked at again next boot. */
export const repairWorkspaceExecutableBits = async (services: Pick<Services, "agentWorktrees" | "workspace">, logger: Logger): Promise<void> => {
    const repos = ["root", ...(await discoverRepos(services.workspace.root).catch((): string[] => []))];
    for (const repo of repos) {
        try {
            const marked = await services.agentWorktrees.withRepoLock(repo, () => repairExecutableBits(services.agentWorktrees.mainDir(repo)));
            if (marked.length > 0) {
                logger.info({ repo, paths: marked }, "exec bits: recorded +x for scripts stored without it, staged for the owner to commit");
            }
        } catch (error) {
            logger.warn({ err: error, repo }, "exec bits: repair failed, the repo's scripts may still check out without +x");
        }
    }
};
