import { procedure } from "../protocol/route-meta.js";
import { AgentSummarySchema } from "../schemas/agents.js";
import {
    SealAnswerSchema,
    SealApproveSchema,
    SealHouseSchema,
    SealIdSchema,
    SealOpenCeremonySchema,
    SealOpenPrepareSchema,
    SealSetDefaultSchema,
    SealSetHouseSchema,
    SealSetSchema,
} from "../schemas/seal.js";
import { SealOpenProofSchema } from "../schemas/seal-proof.js";

// PRIVATE CONVERSATIONS (schemas/seal.ts). Every route here is a person's: none is open to the agent token, a panel or a
// control token, so no agent ever makes, reads past or opens a seal, the owner's own agents included. Each route
// decides inside whose hands it may be in (the author, a reader, the sandbox owner); the floors only keep a viewer to
// asking and answering.
export const sealContract = {
    house: procedure
        .route({
            method: "GET",
            path: "/seal",
            summary: "Who reads whose conversations",
            description:
                "The house rule for private conversations, whether an organisation fixed it, and whether a conversation you start now begins private.",
        })
        .output(SealHouseSchema),
    setHouse: procedure
        .route({
            method: "POST",
            path: "/seal/house",
            summary: "Set who reads whose conversations",
            description:
                "Sets the house rule. It applies to conversations started from now on: a conversation that is already private stays private whatever the rule becomes, until its author shares it.",
        })
        .meta({ floor: "maintainer" })
        .input(SealSetHouseSchema)
        .output(SealHouseSchema),
    setDefault: procedure
        .route({
            method: "POST",
            path: "/seal/default",
            summary: "Start my conversations private",
            description: "Your own answer to whether the conversations you start begin private, where the house rule leaves it to each author.",
        })
        .meta({ floor: "viewer", guest: true })
        .input(SealSetDefaultSchema)
        .output(SealHouseSchema),
    set: procedure
        .route({
            method: "POST",
            path: "/seal/{id}",
            summary: "Make a conversation private or shared",
            description:
                "Makes a conversation private to its author and the people they name, or shared again. Only its author may, or one of its readers when nobody answers for it. Its subagents and reviews follow it. What it already landed stays where it is.",
        })
        .meta({ floor: "viewer", guest: true })
        .input(SealSetSchema)
        .output(AgentSummarySchema),
    ask: procedure
        .route({
            method: "POST",
            path: "/seal/{id}/ask",
            summary: "Ask to read a private conversation",
            description: "Asks its author to show it to you. They can show it for a day, add you as a reader, or say no; nothing opens until they answer.",
        })
        .meta({ floor: "viewer" })
        .input(SealIdSchema)
        .output(AgentSummarySchema),
    answer: procedure
        .route({
            method: "POST",
            path: "/seal/{id}/answer",
            summary: "Answer an ask to read",
            description: "The author's answer to someone who asked to read their private conversation: for a day, for good, or no.",
        })
        .meta({ floor: "viewer", guest: true })
        .input(SealAnswerSchema)
        .output(AgentSummarySchema),
    // The document is prepared here rather than in the browser so its nonce and expiry are the daemon's, and the reason
    // the author is shown is exactly the one that was signed.
    prepareOpen: procedure
        .route({
            method: "POST",
            path: "/seal/{id}/open/prepare",
            summary: "Prepare to open a private conversation without asking",
            description:
                "For the sandbox owner alone: writes the document their passkey signs to open a private conversation without asking its author, with the reason they gave. Nothing opens yet.",
        })
        .meta({ floor: "owner" })
        .input(SealOpenPrepareSchema)
        .output(SealOpenCeremonySchema),
    open: procedure
        .route({
            method: "POST",
            path: "/seal/{id}/open",
            summary: "Open a private conversation without asking",
            description:
                "For the sandbox owner alone, with their passkey over the reason: lets them read a private conversation for a day without its author's yes. It is read-only, its author is told at once, and the reason stays on the conversation for good. Where an organisation asks for two people, it waits for a second person with Full access to agree.",
        })
        .meta({ floor: "owner" })
        .input(SealOpenProofSchema)
        .output(AgentSummarySchema),
    approveOpen: procedure
        .route({
            method: "POST",
            path: "/seal/{id}/open/approve",
            summary: "Agree to an opening without asking",
            description:
                "The second person an organisation's two-person rule asks for: agrees to the owner opening a private conversation without asking, or refuses it. The owner cannot be their own second person.",
        })
        .meta({ floor: "maintainer" })
        .input(SealApproveSchema)
        .output(AgentSummarySchema),
};
