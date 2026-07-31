import type { IntenticApi } from "@intentic/extension-api";
import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { stagingDir } from "./paths.js";

/* What a repo's STAGED document set actually contains, as tails relative to the set's root (`repo.json`,
 * `_libs/graph/doc.md`, …).
 *
 * Two callers need exactly this, which is why it is one function rather than two walks: PUBLISH copies every tail
 * into the repo, and a generation run's ADVANCE step asks "which packages already have a document?" to decide
 * which agents still need starting. Deriving that from the filesystem rather than from bookkeeping is what makes
 * advancing a run idempotent — it can run on every poll, in any browser, after any interruption, and start each
 * package's agent exactly once.
 *
 * It has to be a walk because the daemon lists one directory at a time (`GET /workspace/children`) and a document
 * set nests as deep as the package paths do. Bounded by MAX_LEVELS so a surprising tree cannot turn a render into
 * an unbounded request fan-out. */

// `_apps/web` is two levels; a monorepo nesting packages three deep under a group directory is the realistic
// worst case. Past that the set is not shaped like anything this extension writes.
const MAX_LEVELS = 5;

export const listStagedTails = async (api: IntenticApi, repo: string): Promise<readonly string[]> => {
    const root = stagingDir(repo);
    const tails: string[] = [];
    const children = async (path: string): Promise<readonly { name: string; type: string }[]> => {
        try {
            const body = await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(path)}`);
            return WorkspaceChildrenSchema.parse(body).entries;
        } catch {
            // A directory that is not there is the ordinary answer for a repo with nothing staged.
            return [];
        }
    };
    const walk = async (path: string, tail: string, level: number): Promise<void> => {
        const entries = await children(path);
        const directories = entries.filter((entry) => entry.type === `dir`);
        for (const entry of entries) {
            if (entry.type === `file`) {
                tails.push(tail === `` ? entry.name : `${tail}/${entry.name}`);
            }
        }
        if (level >= MAX_LEVELS) {
            return;
        }
        // Siblings in parallel: the levels are sequential (a child's path is not known until its parent is
        // listed), but a level's directories are independent and a 50-package set is mostly one wide level.
        await Promise.all(directories.map((entry) => walk(`${path}/${entry.name}`, tail === `` ? entry.name : `${tail}/${entry.name}`, level + 1)));
    };
    await walk(root, ``, 0);
    return tails.toSorted();
};

// Which package dirs the staged set holds a document for — a `doc.json` tail's directory part.
export const documentedDirs = (tails: readonly string[]): readonly string[] =>
    tails.filter((tail) => tail.endsWith(`/doc.json`)).map((tail) => tail.slice(0, -`/doc.json`.length));
