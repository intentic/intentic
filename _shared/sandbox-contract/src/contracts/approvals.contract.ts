import { procedure } from "../protocol/route-meta.js";
import { ApprovalIdParamSchema, ApprovalsListSchema, ApprovalSummarySchema, HookDigestParamSchema, HookRequestsSchema } from "../schemas/approvals.js";
import { OkSchema } from "../schemas/shared.js";

// The sandbox's approvals queue (things the agent prepared and may not do until the owner says yes). The agent
// creates the files directly, these routes are the OWNER's side: `list` is the inbox, `upsert` covers approve /
// edit / reschedule / retry (all a plain re-post with a field changed, like the automations enabled toggle),
// `remove` is reject. The verbs are the same whatever the kind, which is the point of one queue.
export const approvalsContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/approvals",
            summary: "Things waiting for your yes",
            description:
                "Everything an agent has prepared and would like to do: posts to publish, actions to carry out. Nothing here has happened yet.",
        })
        .output(ApprovalsListSchema),
    upsert: procedure
        .route({
            method: "POST",
            path: "/approvals",
            summary: "Approve, edit or retry one",
            description: "All three are the same act with a different field changed, so they share one call. Send the item back as you want it.",
        })
        .input(ApprovalSummarySchema)
        .output(OkSchema),
    remove: procedure
        .route({
            method: "DELETE",
            path: "/approvals/{id}",
            summary: "Reject one",
            description: "Throws it away undone.",
        })
        .input(ApprovalIdParamSchema)
        .output(OkSchema),
    // Workspace hooks are a separate record from the queue above: the daemon finds these, never the agent, and their yes
    // is withheld from every machine credential so only a person holding a session can give it.
    hookRequests: procedure
        .route({
            method: "GET",
            path: "/approvals/hooks",
            summary: "Hooks waiting for your yes",
            description:
                "Hook sets a turn found in Claude Code's settings files, or in a skill's or subagent's definition, that nobody has approved in that exact form. Until one is approved, turns in this workspace run with every hook switched off; the sandbox's own safeguards are not hooks of this kind and keep working.",
        })
        .meta({ floor: "maintainer" })
        .output(HookRequestsSchema),
    approveHooks: procedure
        .route({
            method: "POST",
            path: "/approvals/hooks/{digest}/approve",
            summary: "Let a hook set run",
            description:
                "Approves exactly this set, commands and the bytes of the files they run, from the next turn on. Any later change to either is a new set and asks again. Owner and maintainers only, and never through a token a program holds.",
        })
        .meta({ panel: false, control: "never" })
        .input(HookDigestParamSchema)
        .output(OkSchema),
    dismissHooks: procedure
        .route({
            method: "POST",
            path: "/approvals/hooks/{digest}/dismiss",
            summary: "Keep a hook set off without being asked again",
            description:
                "Takes the set off the list. Its hooks stay switched off; a change to them is a new set, which asks again.",
        })
        .meta({ panel: false, control: "never" })
        .input(HookDigestParamSchema)
        .output(OkSchema),
};
