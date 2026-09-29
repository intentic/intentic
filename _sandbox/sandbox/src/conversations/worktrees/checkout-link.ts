import type { AgentWorktrees } from "./worktrees.js";

// The stop a sync or a land makes when a conversation's checkout no longer shares its repository's objects and could
// not be re-linked (worktrees.ts `relink`): every git range either would name is `bad object` there, and a raw
// `Command failed: git …` line told the owner nothing but to press Continue, which met the same failure again.

export class UnlinkedCheckoutError extends Error {
    constructor(readonly repos: readonly string[]) {
        super(unlinkedMessage(repos));
        this.name = "UnlinkedCheckoutError";
    }
}

const nameOf = (repo: string): string => (repo === "root" ? "the workspace" : repo);

// Said to the owner as the turn's failure: what broke, that Continue alone will not get past it, and what will.
export const unlinkedMessage = (repos: readonly string[]): string =>
    `This agent's copy of ${repos.map(nameOf).join(", ")} lost its link to your workspace, and it could not be reconnected ` +
    `by itself, so none of its work was brought over. Pressing Continue will stop here again. Its files are still in its ` +
    `own copy: start a new agent and ask it to carry over what you need, then archive this one.`;

// Re-links what can be re-linked, and stops with the plain reason when something cannot.
export const assertLinked = async (worktrees: Pick<AgentWorktrees, "relink">, id: string, repos: readonly { readonly repo: string }[]): Promise<void> => {
    const broken = await worktrees.relink(id, repos);
    if (broken.length > 0) {
        throw new UnlinkedCheckoutError(broken);
    }
};
