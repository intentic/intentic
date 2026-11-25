import { procedure } from "../protocol/route-meta.js";
import {
    DeployAnswerSchema,
    DeployGrantRequestSchema,
    DeployGrantsResponseSchema,
    DeployHistoryRequestSchema,
    DeployHistoryResponseSchema,
    DeployRequestSchema,
    DeployEnvironmentsResponseSchema,
    PromoteRequestSchema,
    RollbackRequestSchema,
    StackRefSchema,
} from "../schemas/deploys.js";
import { NeedRaisedSchema } from "../schemas/needs.js";
import { OkSchema } from "../schemas/shared.js";

// MANAGED ENVIRONMENTS (schemas/deploys.ts): the stacks the workspace's repositories declare in their stacks manifest,
// deployed by the daemon to the owner's paired computers with their secrets rendered from this sandbox's store. Reads
// and deploys reach the agent token too (`deploys` CLI, the Deployments extension's tools): a fix turn ships its fix.
// Granting a stack secrets is the owner's alone: an agent can only ask for it, on a card. No route here takes a stack
// down or deletes a volume.
const deployRoute = procedure.meta({ control: "never", panel: false });

export const deploysContract = {
    environments: deployRoute
        .route({
            method: "GET",
            path: "/deploys/environments",
            summary: "The stacks this workspace's repositories declare, and how each is doing",
            description:
                "Every stack every repository declares in its stacks manifest: where it runs, what it runs now (commit, image digests), what is deploying or waiting, which secrets it reads and which of those are not granted to it yet, and its state on the computer as the monitor last read it.",
        })
        .meta({ agent: true })
        .output(DeployEnvironmentsResponseSchema),
    history: deployRoute
        .route({
            method: "GET",
            path: "/deploys/history",
            summary: "One stack's deploys, newest first",
            description: "What each deploy of the stack ran, what started it, how it ended and why.",
        })
        .meta({ agent: true })
        .input(DeployHistoryRequestSchema)
        .output(DeployHistoryResponseSchema),
    deploy: deployRoute
        .route({
            method: "POST",
            path: "/deploys/deploy",
            summary: "Deploy a stack at a commit",
            description:
                "Queues a deploy of the stack at the commit (the repository's committed HEAD when none is named). One deploy runs per stack; a newer commit queued behind it replaces an older one still waiting. Refused, with the reason, when a secret it reads is not granted to it or its computer cannot take it.",
        })
        .meta({ agent: true, floor: "maintainer" })
        .input(DeployRequestSchema)
        .output(DeployAnswerSchema),
    rollback: deployRoute
        .route({
            method: "POST",
            path: "/deploys/rollback",
            summary: "Put a stack back on an earlier deploy",
            description: "Deploys the earlier record's commit with its images pinned to the digests it ran.",
        })
        .meta({ agent: true, floor: "maintainer" })
        .input(RollbackRequestSchema)
        .output(DeployAnswerSchema),
    promote: deployRoute
        .route({
            method: "POST",
            path: "/deploys/promote",
            summary: "Deploy one stack at what another runs",
            description: "Deploys `to` at the commit and image digests of `from`'s current deploy: staging, then production.",
        })
        .meta({ agent: true, floor: "maintainer" })
        .input(PromoteRequestSchema)
        .output(DeployAnswerSchema),
    grants: deployRoute
        .route({
            method: "GET",
            path: "/deploys/grants",
            summary: "Which secrets each stack may receive",
        })
        .meta({ agent: true })
        .output(DeployGrantsResponseSchema),
    // An agent's way to a grant: a card in its conversation, answered by the owner. Exit-code semantics like `secrets ask`.
    requestGrant: deployRoute
        .route({
            method: "POST",
            path: "/deploys/grants/request",
            summary: "Ask the owner to let a stack receive the secrets it reads",
        })
        .meta({ agent: true, floor: "maintainer" })
        .input(DeployGrantRequestSchema)
        .output(NeedRaisedSchema),
    // The owner's press: grants exactly the secrets the stack's manifest reads now.
    grant: deployRoute
        .route({
            method: "POST",
            path: "/deploys/grants/grant",
            summary: "Let a stack receive the secrets its manifest reads",
        })
        .meta({ floor: "maintainer", right: "secrets" })
        .input(StackRefSchema)
        .output(DeployGrantsResponseSchema),
    revoke: deployRoute
        .route({
            method: "POST",
            path: "/deploys/grants/revoke",
            summary: "Stop a stack receiving secrets",
            description: "Its next deploy is refused until granted again; what already runs keeps its `.env`.",
        })
        .meta({ floor: "maintainer", right: "secrets" })
        .input(StackRefSchema)
        .output(OkSchema),
};
