import { expect, test } from "vitest";
import type { ControlTokens } from "./control-tokens.js";
import { type Grant, grantsOf } from "./grants.js";

// The verdict alone, for the assertions below: what a grant admits or refuses is the subject here, the
// principal it may hand back is the last test's.
const verdict = async (grant: Grant, presented: string, method: string, path: string) => (await grant.authorize(presented, method, path)).verdict;

// The agent token's reach is the security boundary the vpn/otp CLIs stand on: dialling tunnels and minting
// expiring codes are IN, and every route that would reveal the credentials behind them is OUT. Pinned here
// because widening it is a one-line change that must never happen by accident.
test("the agent grant reaches /vpn and the otp mint, and nothing that reveals a credential", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { resolve: async () => undefined, touch: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: () => undefined,
    });
    const agent = grants.find((grant) => grant.header === "x-intentic-agent");
    if (agent === undefined) {
        throw new Error("no agent grant in the table");
    }
    expect(await verdict(agent, "agent", "GET", "/vpn")).toBe("ok");
    expect(await verdict(agent, "agent", "POST", "/vpn/office/connect")).toBe("ok");
    expect(await verdict(agent, "agent", "GET", "/capabilities/npm/otp")).toBe("ok");
    // The services CLI's three routes: the priced catalog, one metered run (spend bounded platform-side),
    // and a note onto the wanted list (no spend at all).
    expect(await verdict(agent, "agent", "GET", "/pool/services")).toBe("ok");
    expect(await verdict(agent, "agent", "POST", "/pool/services/demo-research/run")).toBe("ok");
    expect(await verdict(agent, "agent", "POST", "/pool/wanted")).toBe("ok");
    // But never the daemon's other pool surfaces, and never a shape the run glob doesn't spell.
    expect(await verdict(agent, "agent", "POST", "/pool/services")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "GET", "/pool/wanted")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "GET", "/pool/services/demo-research/run")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "POST", "/pool/services/a/b/run")).toBe("out-of-scope");
    // The routes a code-minting token must never buy: the manifest, a capability's config, the secrets page.
    expect(await verdict(agent, "agent", "GET", "/capabilities")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "GET", "/capabilities/npm/status")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "GET", "/capabilities/npm/otp/extra")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "POST", "/capabilities/npm/otp")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "GET", "/secrets")).toBe("out-of-scope");
    // A wrong secret on an in-scope route is 401, never a fall-through.
    expect(await verdict(agent, "intruder", "GET", "/capabilities/npm/otp")).toBe("unauthorized");
});

/* The fleet READ surface (agents/fleet.routes.ts) is the one place this token reaches the conversation record,
 * and it is the shape of the grant that keeps it honest: two GETs answering about what the workspace has run,
 * nothing that writes, and nothing on `/agents`, whose neighbours land, discard, archive, rename and place
 * words in an agent's mouth. Pinned because the whole argument for admitting it — "these can only read" —
 * stops being true the first time a verb is added without anyone re-reading this. */
test("the agent grant reaches the fleet reads and never the board's presses", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { resolve: async () => undefined, touch: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: () => undefined,
    });
    const agent = grants.find((grant) => grant.header === "x-intentic-agent");
    if (agent === undefined) {
        throw new Error("no agent grant in the table");
    }
    expect(await verdict(agent, "agent", "GET", "/fleet")).toBe("ok");
    expect(await verdict(agent, "agent", "GET", "/fleet/fair-sage-ey2r")).toBe("ok");
    // Every other verb on the same paths, so a route added later cannot ride in on this grant.
    expect(await verdict(agent, "agent", "POST", "/fleet")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "POST", "/fleet/fair-sage-ey2r")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "DELETE", "/fleet/fair-sage-ey2r")).toBe("out-of-scope");
    // And the glob stays one segment deep: nothing under a conversation is in reach, only the conversation.
    expect(await verdict(agent, "agent", "GET", "/fleet/fair-sage-ey2r/land")).toBe("out-of-scope");
    // The board's own router is untouched by this: reading the fleet never becomes acting on it.
    expect(await verdict(agent, "agent", "GET", "/agents")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "GET", "/agents/fair-sage-ey2r")).toBe("out-of-scope");
    expect(await verdict(agent, "agent", "POST", "/agents/fair-sage-ey2r/land")).toBe("out-of-scope");
});

/* The sync grant is the narrowest in the table and has to stay that way: it belongs to a token that lives on a
 * laptop, so what it can reach is what a stolen laptop can reach. Three things and nothing else: the port
 * listing, the machine's own report, and the SSH byte pipe desktop sync runs on. The pipe is pinned to the GET
 * that opens it: every other shape of that path, and every neighbouring sync route, must stay out of scope. */
test("the sync grant reaches ports, its own report and the ssh transport, and nothing else", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { resolve: async () => undefined, touch: async () => undefined } as unknown as ControlTokens,
        verifySync: async (presented) => presented === "sync",
        verifyExtension: () => undefined,
    });
    const sync = grants.find((grant) => grant.header === "x-intentic-sync");
    if (sync === undefined) {
        throw new Error("no sync grant in the table");
    }
    expect(await verdict(sync, "sync", "GET", "/ports")).toBe("ok");
    expect(await verdict(sync, "sync", "POST", "/system/sync/report")).toBe("ok");
    expect(await verdict(sync, "sync", "GET", "/system/sync/ssh")).toBe("ok");
    // The enrollment surface itself is never in reach of the credential it hands out: a machine cannot enroll
    // another, nor read who else syncs, nor open the transport by any verb but the one that upgrades.
    expect(await verdict(sync, "sync", "POST", "/system/sync/ssh")).toBe("out-of-scope");
    expect(await verdict(sync, "sync", "GET", "/system/sync")).toBe("out-of-scope");
    expect(await verdict(sync, "sync", "POST", "/system/authorized-key")).toBe("out-of-scope");
    expect(await verdict(sync, "sync", "GET", "/secrets")).toBe("out-of-scope");
    // A revoked or forged token on an in-scope route is 401, never a fall-through.
    expect(await verdict(sync, "intruder", "GET", "/system/sync/ssh")).toBe("unauthorized");
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
        controlTokens: { resolve: async () => undefined, touch: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: () => undefined,
    });
    const panel = grants.find((grant) => grant.header === "x-intentic-panel");
    if (panel === undefined) {
        throw new Error("no panel grant in the table");
    }
    // What a panel and a connector gateway actually do, still allowed.
    expect(await verdict(panel, "panel", "GET", "/listeners/discord/state")).toBe("ok");
    expect(await verdict(panel, "panel", "POST", "/listeners/discord/dispatch")).toBe("ok");
    expect(await verdict(panel, "panel", "GET", "/capabilities")).toBe("ok");
    expect(await verdict(panel, "panel", "GET", "/capabilities/reddit/status")).toBe("ok");
    // The doors that were never meant for it: the one that hands a stored credential back…
    expect(await verdict(panel, "panel", "GET", "/capabilities/reddit/connection")).toBe("out-of-scope");
    expect(await verdict(panel, "panel", "GET", "/capabilities/npm/connection")).toBe("out-of-scope");
    /* …and the one that SENDS it. `probe` rehydrates a VAULTED marker from storage and dials a URL the caller
     * supplied, so a panel token could make the daemon present any stored key to an address of its choosing —
     * the same disclosure as the connection read, with nothing in the response to show for it. */
    expect(await verdict(panel, "panel", "POST", "/capabilities/probe")).toBe("out-of-scope");
    // And the carve-out stays narrow: a connection named "probe" is not the probe route.
    expect(await verdict(panel, "panel", "GET", "/capabilities/probe/status")).toBe("ok");
    // A wrong secret on an in-scope route is 401, never a fall-through to the bearer check behind it.
    expect(await verdict(panel, "intruder", "GET", "/capabilities")).toBe("unauthorized");
});

// The extension grant is the backend half's whole reach into the daemon: resolve the minted token to its
// manifest-declared permissions.daemon, then the same glob check the UI half's gate runs. Pinned like the
// agent grant above: an extension backend must never inherit the panel token's everything.
test("the extension grant reaches exactly the declared daemon routes", async () => {
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: { resolve: async () => undefined, touch: async () => undefined } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: (presented) => (presented === "ext-token" ? { permissions: ["GET /workspace/file", "POST /agents"] } : undefined),
    });
    const extension = grants.find((grant) => grant.header === "x-intentic-extension");
    if (extension === undefined) {
        throw new Error("no extension grant in the table");
    }
    expect(await verdict(extension, "ext-token", "GET", "/workspace/file")).toBe("ok");
    expect(await verdict(extension, "ext-token", "GET", "/workspace/file?path=notes.md")).toBe("ok");
    expect(await verdict(extension, "ext-token", "POST", "/agents")).toBe("ok");
    // Undeclared reach is refused as out-of-scope: the readable "this may not go there", not a bare 401.
    expect(await verdict(extension, "ext-token", "GET", "/secrets")).toBe("out-of-scope");
    expect(await verdict(extension, "ext-token", "DELETE", "/workspace/file")).toBe("out-of-scope");
    // An unknown token is 401 whatever it asked for: there is no scope to speak of until the token resolves.
    expect(await verdict(extension, "intruder", "GET", "/workspace/file")).toBe("unauthorized");
});

/* THE CONTROL GRANT NAMES ITS HOLDER. A per-boot secret admits a process; a control token was minted by a person
 * with a label, so an admission hands back the principal the turn will be attributed to, and touches the token's
 * last-use mark. Pinned because both are the audit trail's only road to "which token started this". */
test("the control grant admits with a principal and touches the token; the fixed-secret grants admit nameless", async () => {
    const touched: string[] = [];
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: {
            resolve: async (presented: string) => (presented === "ict_ci" ? { id: "ct-1", label: "nightly CI", scope: "read" as const } : undefined),
            touch: async (id: string) => {
                touched.push(id);
            },
        } as unknown as ControlTokens,
        verifySync: async () => false,
        verifyExtension: () => undefined,
    });
    const control = grants.find((grant) => grant.header === "x-intentic-control");
    const panel = grants.find((grant) => grant.header === "x-intentic-panel");
    if (control === undefined || panel === undefined) {
        throw new Error("grant table incomplete");
    }
    expect(await control.authorize("ict_ci", "GET", "/agents")).toEqual({
        verdict: "ok",
        principal: { kind: "control", id: "ct-1", label: "nightly CI", scope: "read" },
    });
    expect(touched).toEqual(["ct-1"]);
    // Out of scope is refused BEFORE the touch: a token that never got in was not used.
    expect(await control.authorize("ict_ci", "POST", "/agent")).toEqual({ verdict: "out-of-scope" });
    expect(touched).toEqual(["ct-1"]);
    expect(await control.authorize("ict_stranger", "GET", "/agents")).toEqual({ verdict: "unauthorized" });
    expect(await panel.authorize("panel", "GET", "/agents")).toEqual({ verdict: "ok" });
});
