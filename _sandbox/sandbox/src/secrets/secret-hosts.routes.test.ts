import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";
import { errorCode, rejectForbidden } from "../harness/route-client.testing.js";
import type { WidenRequest, WidenVerdict } from "./host-guard-gate.js";
import { effectiveHostGuards } from "./host-guards.js";
import { createSecretHostRoutes, type SecretHostRoutesDeps } from "./secret-hosts.routes.js";
import { secretsSliceFake } from "./secrets-slice.testing.js";

// Who may change a secret's host guard turns on the change, not a role: turning it on or taking hosts off it is open to
// every caller the route admits; turning it off or adding a host is the owner's, asked for on a card when the agent's
// CLI wants it and refused to anybody else. Driven through the handlers with the request context the middleware hands on.

const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };

interface Setup {
    readonly routes: ReturnType<typeof createSecretHostRoutes>;
    readonly slice: ReturnType<typeof secretsSliceFake>;
    readonly widened: WidenRequest[];
}

// `owner`: whether the caller holds the owner's bearer. `defaults`: a connector's own hosts per capability id.
const setup = (options: {
    readonly owner: boolean;
    readonly defaults?: ReadonlyMap<string, readonly string[]>;
    readonly widen?: WidenVerdict;
}): Setup => {
    const slice = secretsSliceFake();
    const widened: WidenRequest[] = [];
    const deps: SecretHostRoutesDeps = {
        auth: options.owner ? undefined : unstubbed<NonNullable<SecretHostRoutesDeps["auth"]>>("auth", { authorizeOwner: rejectForbidden }),
        capabilities: memoryCapabilitiesStore([github]),
        secretRegistry: async () => [{ name: "GITHUB_TOKEN", value: "ghp_value", source: "sandbox" }],
        secretHostGuards: slice.secretHostGuards,
        hostGuards: async () => effectiveHostGuards(await slice.secretHostGuards.list(), options.defaults ?? new Map()),
        hostGuardGate: unstubbed<SecretHostRoutesDeps["hostGuardGate"]>("hostGuardGate", {
            widen: async (request) => {
                widened.push(request);
                return options.widen ?? { refusal: "nobody was asked" };
            },
        }),
    };
    return { routes: createSecretHostRoutes(deps), slice, widened };
};

const signedIn: OrpcContext = { headers: new Headers(), method: "PUT", url: "/secrets/hosts/GITHUB_TOKEN" };
// The agent's CLI: the per-boot token the grant middleware already checked, and the conversation its shell belongs to.
const agentCli: OrpcContext = { ...signedIn, headers: new Headers({ "x-intentic-agent": "agent-token", "x-intentic-conversation": "conv-7" }) };

const GITHUB_ON = { subject: "GITHUB_TOKEN", kind: "secret" as const, guard: true, hosts: ["api.github.com"] };

test("anybody the route admits may turn a guard on, and take hosts off it down to none", async () => {
    const { routes, slice, widened } = setup({ owner: false });
    expect(
        await call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: true, hosts: ["api.github.com", "github.com"] }, { context: signedIn }),
    ).toEqual({
        guard: true,
        hosts: ["api.github.com", "github.com"],
    });
    expect(await call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: true, hosts: [] }, { context: signedIn })).toEqual({
        guard: true,
        hosts: [],
    });
    expect(await slice.secretHostGuards.list()).toEqual([{ subject: "GITHUB_TOKEN", kind: "secret", guard: true, hosts: [] }]);
    expect(widened).toEqual([]);
});

test("turning a guard off or adding a host, from a signed-in person who is not the owner, is refused, and the guard stays", async () => {
    const { routes, slice, widened } = setup({ owner: false });
    await slice.secretHostGuards.set(GITHUB_ON);
    expect(
        await errorCode(
            call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: true, hosts: ["api.github.com", "evil.example"] }, { context: signedIn }),
        ),
    ).toBe("FORBIDDEN");
    expect(await errorCode(call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: false, hosts: ["api.github.com"] }, { context: signedIn }))).toBe(
        "FORBIDDEN",
    );
    expect(await slice.secretHostGuards.list()).toEqual([GITHUB_ON]);
    expect(widened).toEqual([]);
});

test("a loosening from the agent's CLI asks the owner in its conversation, and is stored only on their yes", async () => {
    const approved = setup({ owner: false, widen: { approvedBy: "owner@corp.com" } });
    await approved.slice.secretHostGuards.set(GITHUB_ON);
    expect(
        await call(
            approved.routes.setHosts,
            { subject: "GITHUB_TOKEN", guard: true, hosts: ["api.github.com", "uploads.github.com"] },
            { context: agentCli },
        ),
    ).toEqual({ guard: true, hosts: ["api.github.com", "uploads.github.com"], approvedBy: "owner@corp.com" });
    expect(approved.widened).toEqual([
        {
            subject: "GITHUB_TOKEN",
            from: { guard: true, hosts: ["api.github.com"] },
            to: { guard: true, hosts: ["api.github.com", "uploads.github.com"] },
            conversationId: "conv-7",
            signal: expect.any(AbortSignal),
        },
    ]);

    const declined = setup({ owner: false, widen: { refusal: "The owner kept GITHUB_TOKEN's host guard on." } });
    await declined.slice.secretHostGuards.set(GITHUB_ON);
    expect(
        await errorCode(call(declined.routes.setHosts, { subject: "GITHUB_TOKEN", guard: false, hosts: ["api.github.com"] }, { context: agentCli })),
    ).toBe("FORBIDDEN");
    expect(await declined.slice.secretHostGuards.list()).toEqual([GITHUB_ON]);
});

test("the owner turns a guard off and back on without a card, and the list is kept between", async () => {
    const { routes, slice, widened } = setup({ owner: true });
    await slice.secretHostGuards.set(GITHUB_ON);
    expect(await call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: false, hosts: ["api.github.com"] }, { context: signedIn })).toEqual({
        guard: false,
        hosts: ["api.github.com"],
    });
    expect(await slice.secretHostGuards.list()).toEqual([{ ...GITHUB_ON, guard: false }]);
    await call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: true, hosts: ["api.github.com"] }, { context: signedIn });
    expect(await slice.secretHostGuards.list()).toEqual([GITHUB_ON]);
    // Off with nothing to keep, and no connector's default beneath it, is no setting at all.
    await call(routes.setHosts, { subject: "GITHUB_TOKEN", guard: false, hosts: [] }, { context: signedIn });
    expect(await slice.secretHostGuards.list()).toEqual([]);
    expect(widened).toEqual([]);
});

test("the owner turns a connector's default guard off and back on, and a vault name edits its capability's guard", async () => {
    const { routes } = setup({ owner: true, defaults: new Map([["github", ["api.github.com", "github.com"]]]) });
    expect(await call(routes.hosts, undefined, { context: signedIn })).toEqual({
        guards: [{ subject: "github", kind: "capability", guard: true, hosts: ["api.github.com", "github.com"], source: "connector" }],
    });
    await call(routes.setHosts, { subject: "github/token", guard: false, hosts: [] }, { context: signedIn });
    expect(await call(routes.hosts, undefined, { context: signedIn })).toEqual({
        guards: [{ subject: "github", kind: "capability", guard: false, hosts: [], source: "owner" }],
    });
    await call(routes.setHosts, { subject: "github", guard: true, hosts: ["api.github.com", "github.com"] }, { context: signedIn });
    expect(await call(routes.hosts, undefined, { context: signedIn })).toEqual({
        guards: [{ subject: "github", kind: "capability", guard: true, hosts: ["api.github.com", "github.com"], source: "owner" }],
    });
});

test("taking a host off a connector's default is a tightening anybody may make, and becomes the owner's setting", async () => {
    const { routes } = setup({ owner: false, defaults: new Map([["github", ["api.github.com", "github.com"]]]) });
    await call(routes.setHosts, { subject: "github", guard: true, hosts: ["api.github.com"] }, { context: signedIn });
    expect(await call(routes.hosts, undefined, { context: signedIn })).toEqual({
        guards: [{ subject: "github", kind: "capability", guard: true, hosts: ["api.github.com"], source: "owner" }],
    });
});

test("a name that is neither a stored secret nor a connected account is not found", async () => {
    const { routes } = setup({ owner: true });
    expect(await errorCode(call(routes.setHosts, { subject: "NOPE", guard: true, hosts: ["api.example.com"] }, { context: signedIn }))).toBe(
        "NOT_FOUND",
    );
    expect(
        await errorCode(
            call(routes.setHosts, { subject: "GITHUB_TOKEN", kind: "capability", guard: true, hosts: ["api.example.com"] }, { context: signedIn }),
        ),
    ).toBe("NOT_FOUND");
});
