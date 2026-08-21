import { sandboxPoll } from "@intentic/extension-api";
import { parseDocIndex } from "./docModel.js";
import { host } from "./host.js";
import { INDEX_TAIL, publishedPath, REPO_DOC_TAIL, underRepo } from "./paths.js";
import { documentedDirs, listStagedTails } from "./stagedTree.js";

/* WHICH DIRECTORIES HAVE A DOCUMENT, the state behind the icon on a Workspace tree row.
 *
 * Module state with its own poll, for the same reason attention.ts has one and not for a different one: the host
 * asks `detect(path)` while nothing of this extension is mounted (the reader is browsing files, not reading docs),
 * so a vue-query inside a view could never answer. Nothing observes an unmounted view, so the file-change push
 * cannot serve this either, it invalidates queries, and there is no query here to invalidate.
 *
 * Keyed by WORKSPACE path (`intentic/_sandbox/acp-bridge`), not by (repo, dir): that is the vocabulary the tree
 * speaks, and it is what the tab stores. A repo's own row is in here too, under the repo's path, the repository
 * overview (`repo.md`) is a document like any other, and the row that has health and history should have it too.
 *
 * Both trees count. A staged draft is something to READ, which is the question the icon answers; the tab it opens
 * then says plainly that it is a draft. Published wins where both exist, because that is what the tab opens by
 * default. */

export interface DocumentPresence {
    // The package's one-line description from the index, so hovering the row's icon says what the thing IS. Empty
    // for a repo overview and for a staged document (whose index has not necessarily been generated yet).
    readonly oneLiner: string;
    // Only a draft exists, worth saying on the row, since it is not in the repository yet.
    readonly draft: boolean;
}

/* The published set, as package dir → its one-liner. ONE read per repository serves every package it documents,
 * because the derived index (`intentic-docs check` writes it; nothing authors it) already holds both the list and
 * the descriptions, which is also why the row's tooltip can say what a package IS without a read per row.
 *
 * A repo whose set was hand-written and never checked has no index and therefore no icons: the same blind spot
 * the view's own package list has, and the same fix.
 *
 * Only asked of a repo whose `docs` fact is true (see scan), a repo that documents nothing is not asked at all. */
const publishedEntries = async (repo: string): Promise<ReadonlyMap<string, string>> => {
    try {
        // An index that does not parse is an index that says nothing, the same answer as a missing one, and not
        // this module's business to complain about: the view renders the set, and the tool regenerates it.
        const index = parseDocIndex((await host().workspace.file(publishedPath(repo, INDEX_TAIL))) ?? ``);
        return new Map((index?.entries ?? []).map((entry) => [entry.dir, entry.oneLiner] as const));
    } catch {
        // No index is the ordinary state of a repository nobody has documented yet.
        return new Map();
    }
};

/* Whether the repository's own OVERVIEW is published, `repo.json`, the same marker the staged side reads, so a
 * repo's row means one thing on both trees.
 *
 * Not "its index lists packages", which is what this used to ask. An index is derived bookkeeping that
 * `intentic-docs check` writes for whatever directory it is pointed at, so a repo can hold one with no map beside
 * it, a workspace root pointed at every package under it is the ordinary way that happens. The row then promised
 * a document that opens empty, and the area would offer to open on a repository whose overview does not exist. The
 * map is what a reader lands on, so the map is the question. */
const hasPublishedMap = async (repo: string): Promise<boolean> => {
    try {
        return (await host().workspace.file(publishedPath(repo, REPO_DOC_TAIL))) !== undefined;
    } catch {
        // One unreachable repo must not blank the others; the next poll picks it up.
        return false;
    }
};

/* Slow on purpose, like the badge's. Documents appear when a generation run finishes or a publish lands,
 * minutes apart, and the two moments that matter (publish, discard) call refresh() directly rather than
 * waiting.
 *
 * A MINUTE RATHER THAN THE BADGE'S TEN, and the difference is which half of this read the file binding covers.
 * The STAGED side lives under `.intentic/config/docs/`, so a run writing into it wakes this (background.ts). The
 * PUBLISHED side is `docs/architecture` inside each repo, ordinary source under no declaration anyone could
 * write narrowly, so a hand-edited or agent-committed page is still learnt on the interval.
 *
 * Sandbox-scoped, and this is the state where carrying over is most visibly wrong: the keys are workspace
 * paths, the Workspace tree draws an icon on every row it has an entry for, and two sandboxes of the same
 * monorepo share nearly every path. A switch would leave the tree offering documents that were generated in the
 * box the reader just left. */
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
            /* THE `docs` FACT DECIDES WHETHER THE PUBLISHED SIDE IS READ AT ALL. The daemon already knows which
             * repos carry a `docs/architecture` directory, it computes that in the same pass as every other repo
             * fact, so asking an undocumented repo for its index and its map was two round trips per repo per
             * poll, forever, to learn something the shell was already told. The staged side has no such fact
             * (nothing publishes it, and a run writes into it between polls), so it is still walked. */
            api.workspace.repos().map(async ({ repo, docs }) => {
                const [published, staged, map] = await Promise.all([
                    docs ? publishedEntries(repo) : new Map<string, string>(),
                    listStagedTails(api, repo),
                    docs ? hasPublishedMap(repo) : false,
                ]);
                // Drafts first, so a published document overwrites its draft's entry rather than the other way
                // round: the tab opens the published page, and the row should not call it a draft.
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

// What this workspace path has to read, if anything. A plain Map lookup, the host calls this for every visible
// directory row on every render of the tree.
export const documentAt = (path: string): DocumentPresence | undefined => documents.value.get(path);
