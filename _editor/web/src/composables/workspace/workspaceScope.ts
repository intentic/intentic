import { ref } from "vue";

/* WHOSE COPY OF THE WORKSPACE THIS VIEW IS SHOWING — one conversation's private checkout, or the shared /work
 * tree (undefined).
 *
 * There has never been only one workspace. An isolated conversation gets its own checkout, writes files into
 * it, and then talks about them: "I put the plan in docs/plan.md". Reading that from the shared tree opened a
 * not-found page for a file it had just written, and — worse, because nothing said so — the SHARED version of
 * any file it had merely edited. The path was never the whole address.
 *
 * A module-level singleton, like useWorkspaceTabs and useLayout, for the same reason they are: the surfaces
 * that need it are not in one subtree. The chat sets it from outside the Workspace, the tree and every file
 * read consult it, and the route mirrors it so a scoped link survives a reload, a copy-paste and a new tab.
 *
 * ONE SCOPE AT A TIME, not one per tab. A conversation's checkout is a whole workspace, not a file: browsing
 * one while the tree beside it lists the other is how a reader ends up in a folder that does not contain the
 * file they are looking at. So switching scope re-points the whole view — tree, open files, previews — the way
 * checking out a branch does in an editor, and the banner (WorkspaceScopeBanner) keeps the answer on screen.
 *
 * READ-ONLY WHILE SCOPED. The daemon refuses writes into a checkout by construction (no write route can even
 * name one), and the editor hides its edit affordances to match — an agent may be writing to the same file
 * this second, and the two writers would lose each other's work with nothing to notice it. Unsaved buffers in
 * the shared tree are keyed by path and simply left alone: nothing is dropped, and they are there again on the
 * way back.
 */
export const workspaceAgent = ref<string | undefined>(undefined);

// The scope as a query parameter, for the read routes that take one. Appends nothing for the shared tree, so
// every existing URL stays byte-identical.
export const scopeQuery = (query: URLSearchParams): URLSearchParams => {
    if (workspaceAgent.value !== undefined) {
        query.set(`agent`, workspaceAgent.value);
    }
    return query;
};
