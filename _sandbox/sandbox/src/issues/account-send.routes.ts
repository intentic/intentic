import { AccountSendSchema, ISSUE_PAYLOAD_MAX } from "@intentic/sandbox-contract/schemas/issues";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { routeCallerOf } from "../links/route-caller.js";
import { accountOutboxOf } from "./account-outbox.js";
import { titleOf } from "./fingerprint.js";
import { claimedHere } from "./project-claims.js";
import { projectSuggestions } from "./project-suggestions.js";

// The sending side's loopback doors, for the `projects` command on the agent's PATH (bin/projects): report a problem to
// whichever sandbox on the owner's account claims a project, read what is still waiting, list this sandbox's own claims
// and the projects its repos could claim.
// One outbox per daemon, shared with the drain the boot schedulers run (account-outbox.ts startAccountOutbox).

// Who is asking is the proven conversation and the people it acts for (links/route-caller.ts): a report from no
// proven conversation goes naming nobody, and one from a conversation acting for several people names none of them.

export const accountSendRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /account/outbox": async (c: Context<AppEnv>) => {
        const caller = await routeCallerOf(services, c);
        if (caller.refused !== undefined) {
            return c.json({ error: caller.refused }, 403);
        }
        const read = await readBoundedJson(c.req.raw, ISSUE_PAYLOAD_MAX);
        const parsed = read.kind === "ok" ? AccountSendSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "a report names a project and a problem: {project, report: {kind: detection|crash, message, …}}" }, 400);
        }
        return c.json(await accountOutboxOf(services).send(parsed.data.project, parsed.data.report, { conversationId: caller.conversationId, person: caller.person }));
    },
    "GET /account/outbox": async (c: Context<AppEnv>) => {
        const entries = await accountOutboxOf(services).list();
        return c.json({
            waiting: entries.map((entry) => {
                const what = entry.kind === "report" ? { project: entry.project, title: titleOf(entry.report) } : { project: entry.target, title: entry.note ?? "a drop" };
                const row = { id: entry.id, ...what, times: entry.times, firstAt: entry.firstAt, nextAt: entry.nextAt };
                return entry.lastError === undefined ? row : { ...row, lastError: entry.lastError };
            }),
        });
    },
    "GET /account/projects": async (c: Context<AppEnv>) => {
        const claims = await claimedHere(services.config);
        return claims.ok ? c.json({ projects: [...claims.projects] }) : c.json({ error: claims.problem }, 502);
    },
    // What this workspace could claim, whatever is claimed already: the reader compares against the claims they hold.
    "GET /account/projects/suggest": async (c: Context<AppEnv>) => c.json({ projects: await projectSuggestions(services.workspace.root) }),
}));
