import { oc } from "@orpc/contract";
import { IssueIdParamSchema, IssueInstallsSchema, IssueIntakeIdParamSchema, IssuesListSchema, IssueStatusInputSchema } from "../schemas/issues.js";
import { OkSchema } from "../schemas/shared.js";

/* The issues inbox: bug reports that arrived from the owner's own sites and apps, grouped by fingerprint.
 *
 * THE OWNER'S SIDE ONLY. Reports come in through the public `/intake/…` routes, which are deliberately a
 * different prefix rather than a verb on this one: those are reachable by any browser on the internet, these
 * are not, and two id spaces (an automation's public id out there, an issue's fingerprint in here) sharing one
 * path prefix is how a widened rule stops being visible.
 *
 * Nothing here creates an issue. The daemon writes them; this is triage. */
export const issuesContract = {
    list: oc
        .route({
            method: "GET",
            path: "/issues",
            summary: "Bugs your users have reported",
            description: "Everything that has crashed or been written in, grouped so a crash that hit a thousand people is one row with a count.",
        })
        .output(IssuesListSchema),
    status: oc
        .route({
            method: "POST",
            path: "/issues/{id}/status",
            summary: "File one away, or reopen it",
            description: "Moves one issue between open, resolved and ignored. Resolving does not close anything upstream: it is your own inbox.",
        })
        .input(IssueStatusInputSchema)
        .output(OkSchema),
    investigate: oc
        .route({
            method: "POST",
            path: "/issues/{id}/investigate",
            summary: "Put an agent on it now",
            description:
                "Starts a turn on this issue with the crash, its stack and what led up to it as the brief. Answers straight away and runs detached; the issue goes to 'being looked at'.",
        })
        .input(IssueIdParamSchema)
        .output(OkSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/issues/{id}",
            summary: "Throw one away",
            description: "Forgets an issue entirely. It will come back as new if it happens again, which is usually what you want.",
        })
        .input(IssueIdParamSchema)
        .output(OkSchema),
    installs: oc
        .route({
            method: "GET",
            path: "/issues/installs/{automationId}",
            summary: "Which sites have loaded the reporter",
            description:
                "The sites whose pages actually loaded this intake's script, and the ones that were turned away. The answer to 'did the snippet land?', which an empty inbox cannot give you.",
        })
        .input(IssueIntakeIdParamSchema)
        .output(IssueInstallsSchema),
};
