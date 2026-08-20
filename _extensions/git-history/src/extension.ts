import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";
import { repoAt } from "./repos.js";

/* ext-git-history activation: bind the host handle, then register the one surface a commit graph legitimately
 * has plus the command that reaches the one directory the tree cannot offer.
 *
 * A DOCUMENT, NOT A VIEW. `detect()` on a ViewRegistration answers per repo off the daemon's facts, and a rail
 * tile or a directory panel would both be the wrong shape for this: a repository's history is read while looking
 * at that repository's files, and the answer belongs beside them rather than behind a navigation away. That is
 * the same argument the documentation extension makes for its architecture pages, and the same grain, a path.
 *
 * The graph is WIDE, which is why it is a document (an editor-area tab) rather than anything in the sidebar. It
 * is the division VSCode makes between its SCM list and its Git Graph tab, and the uncommitted half of the story
 *, the Changes review, stays in the app's sidebar where it already lives. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);

    context.subscriptions.push(
        api.documents.register({
            id: `git-history`,
            /* Every repository row, and only repository rows. Reading the host's repo facts here is what makes
             * the icon appear the moment a repo is cloned or scaffolded: the tree calls this inside its own
             * computed, and `workspace.repos()` reads a ref, no poll, no fetch, no file to watch.
             *
             * `sitemap` is the glyph the graph has always carried, and it stays that on the row for the reason
             * the icon exists at all: a reader who has seen the tab should recognise the way back into it. Its
             * neighbours on a repo row are `wave-pulse` (health) and `question-circle` (architecture), and a
             * branching tree shares a silhouette with neither. */
            detect: (path) => (repoAt(path) === undefined ? undefined : { icon: `sitemap`, tooltip: `Open git history`, title: `History` }),
            view: async () => (await import(`./GitHistoryTab.vue`)).default,
        }),
    );

    /* THE WORKSPACE ROOT'S HISTORY, which has no row to click.
     *
     * The tree lists what is INSIDE /work; the root repository itself is the container, so it never gets a line
     * of its own. It is also the repository that matters most here, every landed agent branch is a commit on it
     *, so leaving it reachable only by opening some nested repo's history first would hide the main subject
     * behind an unrelated one. The palette is the honest home for a directory with no row. */
    context.subscriptions.push(api.commands.register(`git-history.open`, () => api.documents.open(`git-history`, ``)));
};
