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
        verifyExtension: () => undefined,
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

// The extension grant is the backend half's whole reach into the daemon: resolve the minted token to its
// manifest-declared permissions.daemon, then the same glob check the UI half's gate runs. Pinned like the
// agent grant above — an extension backend must never inherit the panel token's everything.
test("the extension grant reaches exactly the declared daemon routes", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { scopeOf: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: (presented) => (presented === "ext-token" ? { permissions: ["GET /workspace/file", "POST /agents"] } : undefined),
    });
    const extension = grants.find((grant) => grant.header === "x-intentic-extension");
    if (extension === undefined) {
        throw new Error("no extension grant in the table");
    }
    expect(await extension.authorize("ext-token", "GET", "/workspace/file")).toBe("ok");
    expect(await extension.authorize("ext-token", "GET", "/workspace/file?path=notes.md")).toBe("ok");
    expect(await extension.authorize("ext-token", "POST", "/agents")).toBe("ok");
    // Undeclared reach is refused as out-of-scope — the readable "this may not go there", not a bare 401.
    expect(await extension.authorize("ext-token", "GET", "/secrets")).toBe("out-of-scope");
    expect(await extension.authorize("ext-token", "DELETE", "/workspace/file")).toBe("out-of-scope");
    // An unknown token is 401 whatever it asked for: there is no scope to speak of until the token resolves.
    expect(await extension.authorize("intruder", "GET", "/workspace/file")).toBe("unauthorized");
});
