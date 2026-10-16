import { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { AgentSummarySchema } from "@intentic/sandbox-contract/schemas/agents";
import { type AutomationApproval, AutomationApprovalSchema } from "@intentic/sandbox-contract/schemas/automations";
import { routeAccess } from "@intentic/sandbox-contract/protocol/route-meta";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { memberRefusal } from "../auth/role-floor.js";
import { createAttentionRoutes } from "./attention.routes.js";

// What the desktop app's status bar reads over the loopback port: the board's Attention cards plus held wakes, and the
// turns producing something, counted by the contract's own rules (models/agent-lanes.ts), for the owner alone.

const NONE = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const agent = (id: string, status: AgentSummary["status"], extra: Partial<AgentSummary> = {}): AgentSummary =>
    AgentSummarySchema.parse({ id, status, provider: "claude", harness: "claude-code", updatedAt: 10, attention: NONE, ...extra });

const OWNER: MemberRole = "owner";

const asOwner: OrpcContext = {
    headers: new Headers(),
    method: "GET",
    url: "/agents/attention",
    identity: { email: "owner@example.com", role: OWNER, methods: ["host"] },
};

const routesOver = (agents: readonly AgentSummary[], held: readonly AutomationApproval[] = []) => {
    let refreshed = 0;
    const services = {
        agents: unstubbed<Services["agents"]>("agents", {
            refreshStandings: async () => {
                refreshed += 1;
            },
            list: () => [...agents],
        }),
        heldWakes: unstubbed<Services["heldWakes"]>("heldWakes", { list: async () => [...held] }),
    };
    return { routes: createAttentionRoutes(services), refreshed: () => refreshed };
};

test("counts the board's Attention cards, a family once, and the turns producing something", async () => {
    const { routes, refreshed } = routesOver([
        // Parked on a question: a card in Attention.
        agent("asks", "idle", { attention: { ...NONE, question: true } }),
        // Two children of one parent, each needing a plan approved: they ride their family's one card.
        agent("parent", "running"),
        agent("child-a", "idle", { startedBy: "agent:parent", attention: { ...NONE, plan: true } }),
        agent("child-b", "idle", { startedBy: "agent:parent", attention: { ...NONE, plan: true } }),
        // Working: running and resuming produce something; a land in flight and a stop being unwound do not.
        agent("works", "running"),
        agent("resumes", "resuming"),
        agent("lands", "landing"),
        agent("stops", "stopping"),
        // Finished: nothing owed.
        agent("done", "landed"),
    ]);
    // `asks`, the family's one card, and `stops` (a Stop files its card in Attention); `parent`, `works` and `resumes` work.
    expect(await call(routes.attention, undefined, { context: asOwner })).toEqual({ needsYou: 3, working: 3 });
    expect(refreshed()).toBe(1);
});

test("a held automation wake needs the owner too, with no card of its own", async () => {
    const held = AutomationApprovalSchema.safeParse({ id: "wake-1", automationId: "nightly", createdAt: 1 });
    if (!held.success) {
        throw new Error(held.error.message);
    }
    const { routes } = routesOver([], [held.data]);
    expect(await call(routes.attention, undefined, { context: asOwner })).toEqual({ needsYou: 1, working: 0 });
});

test("only the owner reaches it, never a member, a program's token or a panel", () => {
    expect(memberRefusal({ role: "maintainer" }, "GET", "/agents/attention")).toEqual({ error: "owner access required", floor: "owner" });
    expect(memberRefusal({ role: "guest" }, "GET", "/agents/attention")).toEqual({ error: "not open to a guest member", floor: "viewer" });
    expect(memberRefusal({ role: "owner" }, "GET", "/agents/attention")).toBeUndefined();
    const access = routeAccess("GET", agentsContract.attention["~orpc"].meta);
    expect(access).toMatchObject({ auth: "session", floor: "owner", guest: false, agent: false, panel: false, control: "never" });
});
