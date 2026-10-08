import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { createSettingsRoutes } from "./settings.routes.js";
import { AGENT_DOMAIN_NOT_READY } from "../workload/domain/agent-domain-rollout.js";

const context = (headers: Record<string, string> = {}): OrpcContext => ({
    headers: new Headers(headers), method: "POST", url: "/settings/agent-domain",
});

const fixture = (authenticated: boolean, initial: "root" | "unprivileged" = "root") => {
    let mode = initial;
    const services = unstubbed<Services>("services", {
        auth: authenticated ? unstubbed<NonNullable<Services["auth"]>>("auth", {
            authorizeOwner: async (bearer) => {
                if (bearer !== "owner-bearer") { throw new Error("not owner"); }
            },
        }) : undefined,
        agentDomainPolicy: {
            get: async () => ({ agentDomain: mode }),
            set: async ({ agentDomain }) => { mode = agentDomain; },
        },
    });
    return { routes: createSettingsRoutes(services), stored: () => mode };
};

test("only the verified owner bearer can restore root mode", async () => {
    const { routes, stored } = fixture(true, "unprivileged");
    expect(await call(routes.setAgentDomain, { agentDomain: "root" }, {
        context: context({ authorization: "Bearer owner-bearer" }),
    })).toEqual({ ok: true });
    expect(stored()).toBe("root");
});

test("even the owner cannot activate incomplete protection", async () => {
    const { routes, stored } = fixture(true);
    await expect(call(routes.setAgentDomain, { agentDomain: "unprivileged" }, {
        context: context({ authorization: "Bearer owner-bearer" }),
    })).rejects.toMatchObject({ code: "CONFLICT", message: AGENT_DOMAIN_NOT_READY });
    expect(stored()).toBe("root");
});

test("agent, panel, control, foreign and absent bearers cannot change the boundary", async () => {
    const { routes, stored } = fixture(true);
    for (const headers of [
        {}, { "x-intentic-agent": "agent-secret" }, { "x-intentic-panel": "panel-secret" },
        { "x-intentic-control": "ict_valid" }, { authorization: "Bearer foreign-bearer" },
    ]) {
        await expect(call(routes.setAgentDomain, { agentDomain: "unprivileged" }, { context: context(headers) }))
            .rejects.toThrow("Only the signed-in owner");
        expect(stored()).toBe("root");
    }
});

test("unauthenticated loopback is not an owner credential", async () => {
    const { routes, stored } = fixture(false);
    await expect(call(routes.setAgentDomain, { agentDomain: "unprivileged" }, { context: context() }))
        .rejects.toThrow("Only the signed-in owner");
    expect(stored()).toBe("root");
});
