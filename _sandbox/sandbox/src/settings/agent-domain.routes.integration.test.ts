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
            authorize: async (bearer) => {
                const role = ({ "owner-bearer": "owner", "full-bearer": "maintainer", "member-bearer": "collaborator" } as const)[bearer];
                if (role === undefined) { throw new Error("not a member"); }
                return { email: `${role}@example.com`, methods: ["google"], role };
            },
        }) : undefined,
        agentDomainPolicy: {
            get: async () => ({ agentDomain: mode }),
            set: async ({ agentDomain }) => { mode = agentDomain; },
        },
    });
    return { routes: createSettingsRoutes(services), stored: () => mode };
};

test("only a verified bearer with Full access, the owner's included, can restore root mode", async () => {
    for (const bearer of ["owner-bearer", "full-bearer"]) {
        const { routes, stored } = fixture(true, "unprivileged");
        expect(await call(routes.setAgentDomain, { agentDomain: "root" }, {
            context: context({ authorization: `Bearer ${bearer}` }),
        })).toEqual({ ok: true });
        expect(stored()).toBe("root");
    }
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
        { "x-intentic-control": "ict_valid" }, { authorization: "Bearer foreign-bearer" }, { authorization: "Bearer member-bearer" },
    ]) {
        await expect(call(routes.setAgentDomain, { agentDomain: "unprivileged" }, { context: context(headers) }))
            .rejects.toThrow("Only someone signed in with Full access");
        expect(stored()).toBe("root");
    }
});

test("unauthenticated loopback is not an owner credential", async () => {
    const { routes, stored } = fixture(false);
    await expect(call(routes.setAgentDomain, { agentDomain: "unprivileged" }, { context: context() }))
        .rejects.toThrow("Only someone signed in with Full access");
    expect(stored()).toBe("root");
});
