import { procedure } from "../protocol/route-meta.js";
import { OkSchema } from "../schemas/shared.js";
import {
    GrantRevokeSchema,
    NeedAnswerInputSchema,
    NeedIdParamSchema,
    NeedRaisedSchema,
    NeedRaiseSchema,
    NeedSchema,
    NeedSecretInputSchema,
    NeedsListSchema,
    NeedsQuerySchema,
    StandingGrantsSchema,
} from "../schemas/needs.js";

// Needs (docs/architecture/needs.md): the agent's CLIs raise and withdraw them on the agent token; a person reads and
// answers them from the chat, the board and the Needs you inbox. Answering is the operating tier's, like the capability
// and secret routes an answer ends up writing through.

const agentDoor = procedure.meta({ agent: true, control: "never" });
const answerRoute = procedure.meta({ floor: "maintainer", control: "never" });

export const needsContract = {
    ask: agentDoor
        .route({
            method: "POST",
            path: "/needs/ask",
            summary: "Ask a person for something the task needs",
            description:
                "Raises a need in the conversation the calling shell belongs to and holds the call up to `wait` seconds for an answer. Answers `met` when it is usable now (or already was), `open` when it is still waiting, and `refused` when nothing was raised or a person declined. An open need's answer reaches the conversation by itself.",
        })
        // Held open while the person decides, by design.
        .meta({ stream: true })
        .input(NeedRaiseSchema)
        .output(NeedRaisedSchema),
    mine: agentDoor
        .route({
            method: "GET",
            path: "/needs/mine",
            summary: "This conversation's needs",
            description: "Every need the calling shell's conversation raised, newest first, open or answered.",
        })
        .output(NeedsListSchema),
    withdraw: agentDoor
        .route({
            method: "POST",
            path: "/needs/{id}/withdraw",
            summary: "Withdraw a need",
            description: "Closes one of this conversation's open needs because the task no longer needs it. Its card says so.",
        })
        .input(NeedIdParamSchema)
        .output(NeedSchema),
    list: procedure
        .route({
            method: "GET",
            path: "/needs",
            summary: "What agents are waiting on people for",
            description: "Needs across the sandbox, or one conversation's, newest first. Never a secret's value.",
        })
        .input(NeedsQuerySchema)
        .output(NeedsListSchema),
    answer: answerRoute
        .route({
            method: "POST",
            path: "/needs/{id}/answer",
            summary: "Answer a need",
            description:
                "Declines it, or says yes the way its card offered: accept a connection being set up, apply a change, grant for this conversation or the persona, release a gated credential, approve an environment proposal. A release is refused from anyone the gate does not name.",
        })
        .input(NeedAnswerInputSchema)
        .output(NeedSchema),
    provideSecret: answerRoute
        .route({
            method: "POST",
            path: "/needs/{id}/secret",
            summary: "Give a secret a need asked for",
            description:
                "Stores the value under the name the need asked for and meets it. The value goes to the sandbox's secret store and nowhere else: not the answer, not the transcript, not a log.",
        })
        // Puts a credential in motion: withheld from the panel token.
        .meta({ panel: false })
        .input(NeedSecretInputSchema)
        .output(NeedSchema),
    grants: answerRoute
        .route({
            method: "GET",
            path: "/needs/grants",
            summary: "The yeses still standing",
            description:
                "What people allowed conversations beyond their persona or area, and the gated credentials released to them, by conversation. Names only, never a value.",
        })
        .output(StandingGrantsSchema),
    revokeGrant: answerRoute
        .route({
            method: "POST",
            path: "/needs/grants/revoke",
            summary: "Take a yes back",
            description:
                "Takes back one grant or one release. The conversation's next turn runs without it; a turn already running keeps what it mounted.",
        })
        .input(GrantRevokeSchema)
        .output(OkSchema),
};
