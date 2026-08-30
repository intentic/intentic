import { issuesContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { startWake } from "./intake.routes.js";
import { ISSUES_PROVIDER } from "./provider.js";

/* The owner's side of the bug inbox: read it, file a row away, or put an agent on one now.
 *
 * NOTHING HERE CREATES AN ISSUE. Reports arrive at the public `/intake/…` routes and the daemon writes them;
 * this is triage, and the split is what lets the ingest be reachable by strangers while the inbox is not.
 *
 * `investigate` is the interesting one, and it is deliberately the SAME road a wake takes rather than a second
 * one: it opens the issue's own conversation, links the run and hands the same brief. A button that started a
 * subtly different turn from the one an escalation starts would be two behaviours to explain and only one of
 * them ever tested. */
export const createIssuesRoutes = (services: Services) => {
    const i = implement(issuesContract).$context<OrpcContext>();
    return {
        list: i.list.handler(() => services.issues.list()),

        status: i.status.handler(async ({ input }) => {
            if ((await services.issues.setStatus(input.id, input.status, Date.now())) === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no issue with that id" });
            }
            return { ok: true } as const;
        }),

        investigate: i.investigate.handler(async ({ input }) => {
            const issue = await services.issues.read(input.id);
            if (issue === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no issue with that id" });
            }
            /* The intake that received it. An issue outlives the automation that took it in (the owner can
             * delete an intake without deleting the inbox), so this is a real 409 rather than an impossibility:
             * the row stays readable, and only the button that needs a live automation refuses. */
            const automation = await services.automations.get(issue.automationId);
            if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== ISSUES_PROVIDER) {
                throw new ORPCError("CONFLICT", { message: "the intake this arrived through no longer exists" });
            }
            /* Detached, and the click IS the approval: the admission floor holds ISSUE wakes for a person by
             * default, and asking the person who just pressed Investigate to also approve their own press is a
             * queue entry that says nothing. Same argument fireAutomation's `cleared` makes for Run now. */
            void startWake(services, streamAgent, services.issues, automation, issue, "asked").catch((error: unknown) =>
                services.logger.error({ err: error, issue: input.id }, "investigating an issue failed"),
            );
            return { ok: true } as const;
        }),

        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.issues.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no issue with that id" });
            }
            return { ok: true } as const;
        }),

        installs: i.installs.handler(async ({ input }) => ({ origins: await services.issueInstalls.list(input.automationId) })),
    };
};
