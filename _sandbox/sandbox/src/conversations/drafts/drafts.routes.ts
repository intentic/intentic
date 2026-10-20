import type { AgentUnsentSchema } from "@intentic/sandbox-contract/schemas/agents";
import type { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { type Implementer, ORPCError } from "@orpc/server";
import type { z } from "zod";
import type { OrpcContext } from "../../app-env.js";
import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import type { Services } from "../../composition.js";
import { type ComposerDrafts, draftOwnerOf } from "./composer-drafts.js";

// The caller's own unsent words (composer-drafts.ts), and the card's report of them (`unsent`), never another member's: every read and write is keyed by who the
// request proved it is. A draft may name a conversation nobody has started yet; one the registry has must be one the
// caller may see, as for every other route that names a conversation.

type AgentsImplementer = Implementer<typeof agentsContract, OrpcContext, OrpcContext>;

export const draftRoutes = (i: AgentsImplementer, services: Pick<Services, "agents" | "drafts">) => {
    const visibleIfKnown = (id: string, context: OrpcContext): void => {
        const entry = services.agents.entry(id);
        if (entry !== undefined) {
            refuseUnlessVisible(context.identity, provenanceOf(entry));
        }
    };
    return {
        // A client's report of unsent words, for the card. Not activity and legal mid-turn: a message typed while the agent
        // works is exactly the one waiting to go.
        unsent: i.unsent.handler(async ({ input, context }) => {
            const entry = services.agents.entry(input.id);
            if (entry === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            refuseUnlessVisible(context.identity, provenanceOf(entry));
            const summary = await services.agents.setUnsent(input.id, await reportedUnsent(services.drafts, input));
            if (summary === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
            }
            return summary;
        }),
        drafts: i.drafts.handler(async ({ context }) => {
            const { drafts, revision } = await services.drafts.list(draftOwnerOf(context));
            return { drafts: [...drafts], revision };
        }),
        writeDraft: i.writeDraft.handler(async ({ input, context }) => {
            visibleIfKnown(input.id, context);
            return services.drafts.write(draftOwnerOf(context), input);
        }),
        clearDraft: i.clearDraft.handler(async ({ input, context }) => {
            visibleIfKnown(input.id, context);
            return services.drafts.clear(draftOwnerOf(context), input.id, input.revision);
        }),
    };
};

/** What an older client's report of unsent words leaves on the card: it cannot clear what a draft held here still holds. */
const reportedUnsent = async (drafts: Pick<ComposerDrafts, "heldSince">, report: z.infer<typeof AgentUnsentSchema>): Promise<number | null> =>
    report.at ?? (await drafts.heldSince(report.id)) ?? null;
