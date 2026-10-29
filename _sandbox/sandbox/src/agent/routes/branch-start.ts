import type { RepoBranch } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import { worktreeOf } from "../../conversations/registry/agents-store.js";

/** Start in the selected branch's repository unless the caller chose a folder explicitly. */
export const withBranchFolder = <T extends { readonly startIn?: string | undefined; readonly fromBranch?: RepoBranch | undefined }>(input: T): T =>
    input.startIn !== undefined || input.fromBranch === undefined ? input : { ...input, startIn: input.fromBranch.repo === "root" ? "" : input.fromBranch.repo };

// A conversation started from a branch (`fromBranch`, conversations/land/branch-repos.ts), refused at the door before
// the turn exists, so the words stay in the composer and a scheduled opening is refused now rather than when nobody is
// watching. What the branch checkout refuses (a repository that is not there, a branch neither here nor on origin, the
// repository's own main line, an agent's copy) is said in its words; making that checkout here is also what makes the
// local branch from origin's, which the opening compose then cuts from. A runner's turn is refused: its copy is on
// another machine, and the land commits onto the checkout in this sandbox.
export const refuseFromBranch = async (
    services: Pick<Services, "agents" | "branchCheckouts">,
    conversationId: string,
    input: { readonly fromBranch?: RepoBranch | undefined; readonly placement?: { readonly kind: string } | undefined },
): Promise<void> => {
    const from = input.fromBranch;
    if (from === undefined) {
        return;
    }
    if (input.placement?.kind === "runner") {
        throw new ORPCError("BAD_REQUEST", {
            message: "A conversation started from a branch runs in this sandbox: its work is committed onto the branch here, which a runner's copy cannot reach.",
        });
    }
    // Once its copy is composed, the start is latched (placement.branches): the same start again is that opening resent,
    // anything else would ask an existing conversation to move, which none does.
    const placed = worktreeOf(services.agents.entry(conversationId));
    if (placed !== undefined && placed.repos.length > 0) {
        if (placed.branches?.some(({ repo, branch }) => repo === from.repo && branch === from.branch) !== true) {
            throw new ORPCError("BAD_REQUEST", { message: "Only a new conversation can be started from a branch: this one already works where it began." });
        }
        return;
    }
    try {
        await services.branchCheckouts.ensure(from.repo, from.branch);
    } catch (error) {
        if (error instanceof ORPCError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
        }
        throw error;
    }
};
