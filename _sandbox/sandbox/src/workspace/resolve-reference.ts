import { rankRefCandidates, referenceTails } from "@intentic/sandbox-contract";

/* Which workspace file a NAMED reference means, the search behind /workspace/resolve.
 *
 * A path written in prose is a SUFFIX of the real one at best: an agent that has been working in
 * `_editor/web/src` writes `pages/workspace/Foo.vue`, and a turn running in an isolated worktree prints
 * `/history/worktrees/<id>/…`. So the reference as written is tried first, then progressively shorter tails of
 * it (referenceTails), and the first tail anything matches wins.
 *
 * The filesystem and the search engine arrive as functions rather than being reached for here: the ordering IS
 * the behaviour worth testing, and it should be testable without a workspace or an index. */

export const resolveReference = async (
    reference: string,
    root: string,
    // Whether a workspace-relative path names a real file (escape guard included, a `../` climb is not one).
    exists: (relPath: string) => boolean,
    // Every workspace path matching a `**/tail` glob, unranked.
    matching: (glob: string) => Promise<readonly string[]>,
): Promise<{ path?: string }> => {
    const tails = referenceTails(reference, root);
    // The reference AS WRITTEN, when it names a real file. The common case by far, and the only branch that
    // sees files the search engine's sweep excludes (an ignored path the user can still open from the tree).
    const literal = tails[0];
    if (literal !== undefined && exists(literal)) {
        return { path: literal };
    }
    for (const tail of tails) {
        // A tail can match several files (the same filename in a fixture tree, a vendored copy); the ranking
        // both sides share picks the shallowest, which is the one a reader means often enough to open.
        const [best] = rankRefCandidates(tail, await matching(`**/${tail}`));
        if (best !== undefined) {
            return { path: best };
        }
    }
    return {};
};
