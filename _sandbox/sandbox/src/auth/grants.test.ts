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
    // The services CLI's three routes: the priced catalog, one metered run (spend bounded platform-side),
    // and a note onto the wanted list (no spend at all).
    expect(await agent.authorize("agent", "GET", "/pool/services")).toBe("ok");
    expect(await agent.authorize("agent", "POST", "/pool/services/demo-research/run")).toBe("ok");
    expect(await agent.authorize("agent", "POST", "/pool/wanted")).toBe("ok");
    // But never the daemon's other pool surfaces, and never a shape the run glob doesn't spell.
    expect(await agent.authorize("agent", "POST", "/pool/services")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/pool/wanted")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/pool/services/demo-research/run")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "POST", "/pool/services/a/b/run")).toBe("out-of-scope");
    // The routes a code-minting token must never buy: the manifest, a capability's config, the secrets page.
    expect(await agent.authorize("agent", "GET", "/capabilities")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/capabilities/npm/status")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/capabilities/npm/otp/extra")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "POST", "/capabilities/npm/otp")).toBe("out-of-scope");
    expect(await agent.authorize("agent", "GET", "/secrets")).toBe("out-of-scope");
    // A wrong secret on an in-scope route is 401, never a fall-through.
    expect(await agent.authorize("intruder", "GET", "/capabilities/npm/otp")).toBe("unauthorized");
});

/* The sync grant is the narrowest in the table and has to stay that way: it belongs to a token that lives on a
 * laptop, so what it can reach is what a stolen laptop can reach. Three things and nothing else: the port
 * listing, the machine's own report, and the SSH byte pipe desktop sync runs on. The pipe is pinned to the GET
 * that opens it: every other shape of that path, and every neighbouring sync route, must stay out of scope. */
test("the sync grant reaches ports, its own report and the ssh transport, and nothing else", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { scopeOf: async () => undefined } as unknown as ControlTokens,
        verifySync: async (presented) => presented === "sync",
        verifyExtension: () => undefined,
    });
    const sync = grants.find((grant) => grant.header === "x-intentic-sync");
    if (sync === undefined) {
        throw new Error("no sync grant in the table");
    }
    expect(await sync.authorize("sync", "GET", "/ports")).toBe("ok");
    expect(await sync.authorize("sync", "POST", "/system/sync/report")).toBe("ok");
    expect(await sync.authorize("sync", "GET", "/system/sync/ssh")).toBe("ok");
    // The enrollment surface itself is never in reach of the credential it hands out: a machine cannot enroll
    // another, nor read who else syncs, nor open the transport by any verb but the one that upgrades.
    expect(await sync.authorize("sync", "POST", "/system/sync/ssh")).toBe("out-of-scope");
    expect(await sync.authorize("sync", "GET", "/system/sync")).toBe("out-of-scope");
    expect(await sync.authorize("sync", "POST", "/system/authorized-key")).toBe("out-of-scope");
    expect(await sync.authorize("sync", "GET", "/secrets")).toBe("out-of-scope");
    // A revoked or forged token on an in-scope route is 401, never a fall-through.
    expect(await sync.authorize("intruder", "GET", "/system/sync/ssh")).toBe("unauthorized");
});

/* The panel grant is broad on purpose (a panel is an app somebody else wrote) with exactly one route carved
 * out of it. `/capabilities/<id>/connection` returns a capability's config SECRETS INCLUDED and gates only on
 * "no signed-in identity", which the panel token satisfies as surely as the extension token it was written
 * for. Since that token is injected into every panel and connector process in the container, leaving it in
 * reach made a browser account's password and a TOTP seed readable by anything that can read /proc: the two
 * credentials the product states the model is never given. Pinned so re-widening has to be deliberate. */
test("the panel grant reaches the daemon broadly but never the capability connection read", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { scopeOf: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: () => undefined,
    });
    const panel = grants.find((grant) => grant.header === "x-intentic-panel");
    if (panel === undefined) {
        throw new Error("no panel grant in the table");
    }
    // What a panel and a connector gateway actually do, still allowed.
    expect(await panel.authorize("panel", "GET", "/listeners/discord/state")).toBe("ok");
    expect(await panel.authorize("panel", "POST", "/listeners/discord/dispatch")).toBe("ok");
    expect(await panel.authorize("panel", "GET", "/capabilities")).toBe("ok");
    expect(await panel.authorize("panel", "GET", "/capabilities/reddit/status")).toBe("ok");
    // The one door that was never meant for it.
    expect(await panel.authorize("panel", "GET", "/capabilities/reddit/connection")).toBe("out-of-scope");
    expect(await panel.authorize("panel", "GET", "/capabilities/npm/connection")).toBe("out-of-scope");
    // A wrong secret on an in-scope route is 401, never a fall-through to the bearer check behind it.
    expect(await panel.authorize("intruder", "GET", "/capabilities")).toBe("unauthorized");
});

// The extension grant is the backend half's whole reach into the daemon: resolve the minted token to its
// manifest-declared permissions.daemon, then the same glob check the UI half's gate runs. Pinned like the
// agent grant above: an extension backend must never inherit the panel token's everything.
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
    // Undeclared reach is refused as out-of-scope: the readable "this may not go there", not a bare 401.
    expect(await extension.authorize("ext-token", "GET", "/secrets")).toBe("out-of-scope");
    expect(await extension.authorize("ext-token", "DELETE", "/workspace/file")).toBe("out-of-scope");
    // An unknown token is 401 whatever it asked for: there is no scope to speak of until the token resolves.
    expect(await extension.authorize("intruder", "GET", "/workspace/file")).toBe("unauthorized");
});
