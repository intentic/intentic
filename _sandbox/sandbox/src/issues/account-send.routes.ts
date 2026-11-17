import { AccountSendSchema, ISSUE_PAYLOAD_MAX } from "@intentic/sandbox-contract/schemas/issues";
import { ProjectClaimsSchema } from "@intentic/api-contract/ingress";
import { parseJsonOr } from "@intentic/base/json";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { supervisorFor } from "../agent/subagents/children.js";
import type { Services } from "../composition.js";
import { soleLiveConversation } from "../conversations/actor/conversation-holdings.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { callPlatform } from "../system/platform-relay.js";
import { accountOutboxOf } from "./account-outbox.js";
import { titleOf } from "./fingerprint.js";

// The sending side's loopback doors, for the `projects` command on the agent's PATH (bin/projects): report a problem to
// whichever sandbox on the owner's account claims a project, read what is still waiting, list this sandbox's own claims.
// One outbox per daemon, shared with the drain the boot schedulers run (account-outbox.ts startAccountOutbox).

// Reporting to another sandbox is handing something on, so it rides the same rule as delegating: a turn started by
// outside content, or one whose persona does not delegate, has no supervisor armed (children.ts) and may not. A shell no
// planned turn owns (a person's own terminal) may.
const REFUSED =
    "This turn may not report to another sandbox: it was started by outside content, or its persona does not delegate. " +
    "Nothing was sent; say what you saw in your reply instead.";

// Who is asking: the conversation a report is filed from, or why this turn may not report at all.
interface Caller {
    readonly conversationId?: string;
    readonly refused?: string;
}

const callerOf = (services: Services, c: Context<AppEnv>): Caller => {
    const named = c.req.header("x-intentic-conversation");
    const conversationId = named !== undefined && named !== "" ? named : soleLiveConversation(services.conversations);
    if (conversationId === undefined || turnStandingOf(services.conversations, conversationId) === undefined) {
        return {};
    }
    return supervisorFor(services.conversations, conversationId) === undefined ? { refused: REFUSED } : { conversationId };
};

export const accountSendRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /account/outbox": async (c: Context<AppEnv>) => {
        const caller = callerOf(services, c);
        if (caller.refused !== undefined) {
            return c.json({ error: caller.refused }, 403);
        }
        const read = await readBoundedJson(c.req.raw, ISSUE_PAYLOAD_MAX);
        const parsed = read.kind === "ok" ? AccountSendSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "a report names a project and a problem: {project, report: {kind: detection|crash, message, …}}" }, 400);
        }
        return c.json(await accountOutboxOf(services).send(parsed.data.project, parsed.data.report, caller.conversationId));
    },
    "GET /account/outbox": async (c: Context<AppEnv>) => {
        const entries = await accountOutboxOf(services).list();
        return c.json({
            waiting: entries.map((entry) => {
                const row = { id: entry.id, project: entry.project, title: titleOf(entry.report), times: entry.times, firstAt: entry.firstAt, nextAt: entry.nextAt };
                return entry.lastError === undefined ? row : { ...row, lastError: entry.lastError };
            }),
        });
    },
    "GET /account/projects": async (c: Context<AppEnv>) => {
        const answer = await callPlatform(services.config, { route: "projectsMine", unreached: "nothing was read" });
        const claims = ProjectClaimsSchema.safeParse(parseJsonOr(answer.body, undefined));
        if (answer.status !== 200 || !claims.success) {
            return c.json({ error: `the platform did not list this sandbox's projects (${answer.status}): ${answer.body.slice(0, 300)}` }, 502);
        }
        return c.json(claims.data);
    },
}));
