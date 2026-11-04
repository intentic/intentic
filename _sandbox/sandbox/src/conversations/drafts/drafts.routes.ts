import type { AgentUnsentSchema } from "@intentic/sandbox-contract/schemas/agents";
import type { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { type Implementer, ORPCError } from "@orpc/server";
import type { z } from "zod";
import type { OrpcContext } from "../../app-env.js";
import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { MAX_REACTION_KINDS } from "../registry/agents-registry.js";
import { adoptDraftMarks, type ComposerDrafts, draftOwnerOf } from "./composer-drafts.js";

// The caller's own unsent words (composer-drafts.ts), and the card's report of them (`unsent`), never another member's: every read and write is keyed by who the
// request proved it is. A draft may name a conversation nobody has started yet; one the registry has must be one the
// caller may see, as for every other route that names a conversation.

type AgentsImplementer = Implementer<typeof agentsContract, OrpcContext, OrpcContext>;

export const draftRoutes = (i: AgentsImplementer, services: Pick<Services, "agents" | "drafts" | "logger">) => {
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
            const { drafts, revision, reactions } = await services.drafts.list(draftOwnerOf(context));
            // Marks on a conversation that has started since are its card's to show (or about to be, once its send moves
            // them): listed here too they would draw twice. Left in the file rather than moved by a read.
            const unstarted = Object.entries(reactions).filter(([id]) => services.agents.entry(id) === undefined);
            return { drafts: [...drafts], revision, reactions: Object.fromEntries(unstarted.map(([id, marks]) => [id, [...marks]])) };
        }),
        writeDraft: i.writeDraft.handler(async ({ input, context }) => {
            visibleIfKnown(input.id, context);
            return services.drafts.write(draftOwnerOf(context), input);
        }),
        clearDraft: i.clearDraft.handler(async ({ input, context }) => {
            visibleIfKnown(input.id, context);
            return services.drafts.clear(draftOwnerOf(context), input.id, input.revision);
        }),
        // A mark on a conversation the registry has no entry for yet: kept as the caller's, beside their draft, until the
        // first turn moves it onto the card (agent.routes.ts `run`). A started conversation is `react`'s.
        reactDraft: i.reactDraft.handler(async ({ input, context }) => {
            if (services.agents.entry(input.id) !== undefined) {
                throw new ORPCError("CONFLICT", { message: "this conversation has started: mark its card instead" });
            }
            if (context.identity === undefined) {
                throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to attribute the reaction to" });
            }
            const owner = draftOwnerOf(context);
            const answer = await services.drafts.react(owner, input.id, { emoji: input.emoji, ...opt("name", context.identity.name), on: input.on }, MAX_REACTION_KINDS);
            if (answer === "full") {
                throw new ORPCError("BAD_REQUEST", { message: `this conversation already carries ${MAX_REACTION_KINDS} different reactions` });
            }
            // A first turn that registered the conversation while this press was being written has already moved the
            // marks it found: this one goes the same way now, rather than waiting in the file for a send that came first.
            await adoptDraftMarks(services, context, input.id);
            return { reactions: [...answer] };
        }),
    };
};

/** What an older client's report of unsent words leaves on the card: it cannot clear what a draft held here still holds. */
const reportedUnsent = async (drafts: Pick<ComposerDrafts, "heldSince">, report: z.infer<typeof AgentUnsentSchema>): Promise<number | null> =>
    report.at ?? (await drafts.heldSince(report.id)) ?? null;
