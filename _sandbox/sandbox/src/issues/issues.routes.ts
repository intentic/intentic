import { issuesContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { startWake } from "./intake.routes.js";
import { ISSUES_PROVIDER } from "./provider.js";

// The owner's side of the bug inbox: read it, file a row away, or put an agent on it now. Nothing here creates an
// issue, reports arrive at the public /intake/ routes; this is triage, which is what lets the ingest be reachable by
// strangers while the inbox is not. `investigate` deliberately takes the same road as a wake, opening the issue's own
// conversation and handing the same brief, rather than being a second behavior to explain and test.
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
            // An issue outlives its intake: a deleted automation is a real 409 here, the row itself still reads fine.
            const automation = await services.automations.get(issue.automationId);
            if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== ISSUES_PROVIDER) {
                throw new ORPCError("CONFLICT", { message: "the intake this arrived through no longer exists" });
            }
            // Detached: the click is itself the approval, asking them to also approve their own press would say
            // nothing.
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
