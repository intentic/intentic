import type { IntenticApi } from "@intentic/extension-api";
import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { README_TAIL, stagingDir } from "./paths.js";

/* What a repo's STAGED document set actually contains, as tails relative to the set's root (`repo.json`,
 * `_deploy/graph/README.md`, …).
 *
 * Two callers need exactly this, which is why it is one function rather than two walks: PUBLISH copies every tail
 * into the repo, and a generation run's ADVANCE step asks "which packages already have a document?" to decide
 * which agents still need starting. Deriving that from the filesystem rather than from bookkeeping is what makes
 * advancing a run idempotent, it can run on every poll, in any browser, after any interruption, and start each
 * package's agent exactly once.
 *
 * The daemon's bounded-depth children read returns this small subtree as one flat list. That matters here: the
 * old browser-side walk issued one request per discovered directory, and a wide monorepo turned the minute
 * presence poll into a synchronized request fan-out. */

// `_editor/web` is two levels; a monorepo nesting packages three deep under a group directory is the realistic
// worst case. Past that the set is not shaped like anything this extension writes.
const MAX_DEPTH = 5;

export const listStagedTails = async (api: IntenticApi, repo: string): Promise<readonly string[]> => {
    const root = stagingDir(repo);
    try {
        const body = await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(root)}&depth=${MAX_DEPTH}`);
        const prefix = `${root}/`;
        return WorkspaceChildrenSchema.parse(body)
            .entries.filter((entry) => entry.type === `file` && entry.path.startsWith(prefix))
            .map((entry) => entry.path.slice(prefix.length))
            .toSorted();
    } catch {
        // A directory that is not there is the ordinary answer for a repo with nothing staged.
        return [];
    }
};

// Which package dirs the staged set holds a page for, a `README.md` tail's directory part. The map's own tails
// sit at the root of the set and have no directory part, so they cannot be mistaken for a package.
export const documentedDirs = (tails: readonly string[]): readonly string[] =>
    tails.filter((tail) => tail.endsWith(`/${README_TAIL}`)).map((tail) => tail.slice(0, -`/${README_TAIL}`.length));
