import { expect, test } from "vitest";
import type { ControlTokens } from "./control-tokens.js";
import { grantsOf } from "./grants.js";

// The agent token's reach is the security boundary the vpn/otp CLIs stand on: dialling tunnels and minting
// expiring codes are IN, and every route that would reveal the credentials behind them is OUT. Pinned here
// because widening it is a one-line change that must never happen by accident.
test("the agent grant reaches /vpn and the otp mint, and nothing that reveals a credential", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { scopeOf: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
    });
    const agent = grants.find((grant) => grant.header === "x-intentic-agent");
    if (agent === undefined) {
        throw new Error("no agent grant in the table");
    }
    expect(await agent.authorize("agent", "GET", "/vpn")).toBe("ok");
    expect(await agent.authorize("agent", "POST", "/vpn/office/connect")).toBe("ok");
    expect(await agent.authorize("agent", "GET", "/capabilities/npm/otp")).toBe("ok");
    // The routes a code-minting token must never buy: the manifest, a capability's config, the secrets page.
    expect(await agent.authorize("agent", "GET", "/capabilities")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/capabilities/npm/status")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/capabilities/npm/otp/extra")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "POST", "/capabilities/npm/otp")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/secrets")).toBe("out-of-scope");
    // A wrong secret on an in-scope route is 401, never a fall-through.
    expect(await agent.authorize("intruder", "GET", "/capabilities/npm/otp")).toBe("unauthorized");
});
