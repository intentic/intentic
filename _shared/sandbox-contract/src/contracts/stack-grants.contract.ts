import { procedure } from "../protocol/route-meta.js";
import { NeedRaisedSchema } from "../schemas/needs.js";
import { OkSchema } from "../schemas/shared.js";
import { StackGrantRefSchema, StackGrantRequestSchema, StackGrantSetSchema, StackGrantsResponseSchema } from "../schemas/stack-grants.js";

// WHICH SECRETS EACH MANAGED STACK MAY RECEIVE (schemas/stack-grants.ts). Reading the grants reaches an extension (the
// Deployments board shows what is missing) and the agent; granting and revoking are the owner's alone, never a machine
// credential's, and the handlers hold the caller to the Secrets right again. An agent asks on a card instead.
const grantRoute = procedure.meta({ control: "never", panel: false });

export const stackGrantsContract = {
    list: grantRoute
        .route({
            method: "GET",
            path: "/stack-grants",
            summary: "Which secrets each managed stack may receive",
            description: "Every grant: the repository, stack and computer it is for, and the secret names it covers. Names only, never a value.",
        })
        .meta({ agent: true })
        .output(StackGrantsResponseSchema),
    request: grantRoute
        .route({
            method: "POST",
            path: "/stack-grants/request",
            summary: "Ask the owner to let a stack receive some secrets",
            description:
                "Raises a card in the asking conversation listing the names; the owner's yes grants exactly those, for that stack from that repository on that computer.",
        })
        .meta({ agent: true, floor: "maintainer" })
        .input(StackGrantRequestSchema)
        .output(NeedRaisedSchema),
    grant: grantRoute
        .route({
            method: "POST",
            path: "/stack-grants/grant",
            summary: "Let a stack receive these secrets",
        })
        .meta({ floor: "maintainer", right: "secrets" })
        .input(StackGrantSetSchema)
        .output(StackGrantsResponseSchema),
    revoke: grantRoute
        .route({
            method: "POST",
            path: "/stack-grants/revoke",
            summary: "Stop a stack receiving secrets",
            description: "Its next managed deploy is refused until granted again; what already runs keeps its `.env`.",
        })
        .meta({ floor: "maintainer", right: "secrets" })
        .input(StackGrantRefSchema)
        .output(OkSchema),
};
