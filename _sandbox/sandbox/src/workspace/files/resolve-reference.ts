import { rankRefCandidates, referenceTails } from "@intentic/sandbox-contract";

// Resolves a named reference (a path written in prose) to a real workspace file: since it's often only a suffix of the
// true path, the reference is tried as written, then progressively shorter tails, first match wins. Filesystem and
// search arrive as injected functions so the ordering is testable without a real workspace or index.

export const resolveReference = async (
    reference: string,
    root: string,
    // Whether a workspace-relative path names a real file; a `../` escape never counts as one.
    exists: (relPath: string) => boolean,
    // Every workspace path matching a `**/tail` glob, unranked.
    matching: (glob: string) => Promise<readonly string[]>,
): Promise<{ path?: string }> => {
    const tails = referenceTails(reference, root);
    // The reference as written, if it's a real file; the only branch that sees paths the search index ignores.
    const literal = tails[0];
    if (literal !== undefined && exists(literal)) {
        return { path: literal };
    }
    for (const tail of tails) {
        // A tail can match several files; shared ranking picks the shallowest, usually the one meant.
        const [best] = rankRefCandidates(tail, await matching(`**/${tail}`));
        if (best !== undefined) {
            return { path: best };
        }
    }
    return {};
};
