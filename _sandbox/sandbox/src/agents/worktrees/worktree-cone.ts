import { type Fence, fenceAllows, fenceReaches, foldPath } from "@intentic/sandbox-contract";

// What a fenced conversation's checkout actually holds. The hook that fences an agent's file tools stops a misread
// instruction, not a shell, and a shell computes its own paths — so for a conversation started by a fenced person the
// fence has to be the checkout itself. What is not there cannot be read, by a tool, a shell, or a script.

/**
 * Which repositories a fenced conversation carries: the ones its folders reach. A repo the fence never touches is
 * left out of the composition entirely rather than checked out empty, so the agent meets it as absent.
 * `root` is always carried — it is the directory the others mount into.
 */
export const fencedComposition = (fence: Fence, repos: readonly string[]): string[] =>
    fence === undefined ? [...repos] : repos.filter((repo) => repo === "root" || fenceReaches(fence, repo));

/**
 * The sparse-checkout cone for one repository, as repo-relative directories, or undefined when the repo should be
 * checked out whole (no fence, or a fence that contains the entire repo).
 * An empty array is a real answer: the fence reaches this repo but names nothing tracked inside it, which cone mode
 * renders as the repo's root-level files alone.
 */
export const coneFor = (fence: Fence, repo: string): readonly string[] | undefined => {
    if (fence === undefined) {
        return undefined;
    }
    const base = repo === "root" ? "" : (foldPath(repo) ?? repo);
    // The fence holds the whole repository: nothing to cut, and cutting would only cost a checkout rewrite.
    if (base !== "" && fenceAllows(fence, base)) {
        return undefined;
    }
    return (
        fence
            .map((folder) => foldPath(folder))
            .filter((folder): folder is string => folder !== undefined)
            .filter((folder) => base === "" || folder.startsWith(`${base}/`))
            .map((folder) => (base === "" ? folder : folder.slice(base.length + 1)))
            // A nested repository's own folders are its checkout's business, not the root's; the root repo excludes them.
            .filter((folder) => folder !== "")
    );
};
