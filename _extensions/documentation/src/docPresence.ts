import { sandboxPoll } from "@intentic/extension-api";
import { parseDocIndex } from "./docModel.js";
import { host } from "./host.js";
import { INDEX_TAIL, publishedPath, REPO_DOC_TAIL, underRepo } from "./paths.js";
import { documentedDirs, listStagedTails } from "./stagedTree.js";

// Tracks which workspace paths have a document, for the tree row's icon; a standalone poll since the host asks this
// with nothing of the extension mounted to answer or invalidate. Keyed by workspace path, matching the tree and tab;
// both staged and published count, published winning when both exist.

export interface DocumentPresence {
    // One-line description from the index, for the tooltip; empty for a repo overview or an ungenerated staged doc.
    readonly oneLiner: string;
    // True when only a draft exists, not yet in the repository.
    readonly draft: boolean;
}

// One read per repo covers every package it documents, via the generated index (never hand-authored). Only asked when
// the repo's `docs` fact is true; an unchecked repo has no index and so no icons.
const publishedEntries = async (repo: string): Promise<ReadonlyMap<string, string>> => {
    try {
        // A parse failure answers the same as a missing index; not this module's job to complain.
        const index = parseDocIndex((await host().workspace.file(publishedPath(repo, INDEX_TAIL))) ?? ``);
        return new Map((index?.entries ?? []).map((entry) => [entry.dir, entry.oneLiner] as const));
    } catch {
        // No index is the ordinary state of a repository nobody has documented yet.
        return new Map();
    }
};

// Checks for `repo.json`, the same marker the staged side uses, not whether the index lists packages: a repo can have
// an index with no map, which would promise a document that opens empty.
const hasPublishedMap = async (repo: string): Promise<boolean> => {
    try {
        return (await host().workspace.file(publishedPath(repo, REPO_DOC_TAIL))) !== undefined;
    } catch {
        // One unreachable repo must not blank the others; the next poll picks it up.
        return false;
    }
};

// Polls every minute since only the published side needs it; staged reacts to writes and publish/discard call refresh()
// directly. Sandbox-scoped: paths collide across sandboxes of the same monorepo.
const {
    state: documents,
    start: startDocumentPresence,
    refresh: refreshDocumentPresence,
} = sandboxPoll<ReadonlyMap<string, DocumentPresence>>({
    host,
    everyMs: 60_000,
    initial: () => new Map(),
    read: async (api) => {
        const next = new Map<string, DocumentPresence>();
        await Promise.all(
            // The `docs` fact gates published-side reads entirely; the staged side has no such fact, so it's always
            // walked.
            api.workspace.repos().map(async ({ repo, docs }) => {
                const [published, staged, map] = await Promise.all([
                    docs ? publishedEntries(repo) : new Map<string, string>(),
                    listStagedTails(api, repo),
                    docs ? hasPublishedMap(repo) : false,
                ]);
                // Drafts written first, so a published entry overwrites it rather than the reverse.
                if (staged.includes(REPO_DOC_TAIL)) {
                    next.set(repo, { oneLiner: ``, draft: true });
                }
                for (const dir of documentedDirs(staged)) {
                    next.set(underRepo(repo, dir), { oneLiner: ``, draft: true });
                }
                if (map) {
                    next.set(repo, { oneLiner: ``, draft: false });
                }
                for (const [dir, oneLiner] of published) {
                    next.set(underRepo(repo, dir), { oneLiner, draft: false });
                }
            }),
        );
        return next;
    },
});

export { refreshDocumentPresence, startDocumentPresence };

// What this workspace path has to read, if anything; a plain Map lookup called for every visible tree row on render.
export const documentAt = (path: string): DocumentPresence | undefined => documents.value.get(path);
