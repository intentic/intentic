import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { SandboxMode } from "@intentic/sandbox-contract/schemas/sandbox-mode";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { call } from "@orpc/server";
import type { ProvenCaller } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { createAudienceRoutes } from "./audience.routes.js";

// The words a person's editor uses follow how the sandbox runs (plain on a hands-off sandbox, git's on a hands-on one)
// unless they chose their own, which the sandbox keeps per person so every device they open it on agrees. An offer is
// what a browser from before the mode sends, the answer it kept on its own and handed to every sandbox it opened: it is
// never taken any more, and no member's choice is another's.

// A fresh history volume per test, since the choices are a file on it, on a sandbox running as `mode` says.
const routesOn = (mode: SandboxMode = "hands-on") =>
    createAudienceRoutes(
        unstubbed<Pick<Services, "config" | "sandboxSettings">>("services", {
            config: unstubbed<Services["config"]>("config", { historyRoot: mkdtempSync(join(tmpdir(), "member-audience-")) }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
                get: async () => SandboxSettingsSchema.parse({ mode }),
            }),
        }),
    );

// The call as this person makes it; no address is the loopback caller, who has no member identity.
const as = (email: string | undefined) => {
    const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/settings/audience" };
    if (email !== undefined) {
        const identity: ProvenCaller = { email, role: "collaborator", methods: ["google"] };
        context.identity = identity;
    }
    return { context };
};

test("nobody who has not chosen reads what the sandbox's mode speaks", async () => {
    await expect(call(routesOn("hands-on").audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "developer", mode: "hands-on" });
    await expect(call(routesOn("hands-off").audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "maker", mode: "hands-off" });
});

test("a choice is kept, and read back on the person's next device", async () => {
    const routes = routesOn("hands-off");

    await expect(call(routes.setAudience, { audience: "developer" }, as("ann@example.com"))).resolves.toEqual({
        audience: "developer",
        adopted: true,
        override: "developer",
    });
    await expect(call(routes.audience, undefined, as("Ann@Example.com"))).resolves.toEqual({
        audience: "developer",
        mode: "hands-off",
        override: "developer",
    });
});

test("null forgets the choice, and the sandbox's words come back", async () => {
    const routes = routesOn("hands-off");
    await call(routes.setAudience, { audience: "developer" }, as("ann@example.com"));

    await expect(call(routes.setAudience, { audience: null }, as("ann@example.com"))).resolves.toEqual({ audience: "maker", adopted: true });
    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "maker", mode: "hands-off" });
});

/* THE LEAK THIS CLOSES: a browser's answer no longer becomes a choice on a sandbox it was never given for. */
test("an offer is never taken, and answers the words the sandbox speaks", async () => {
    const routes = routesOn("hands-off");

    await expect(call(routes.setAudience, { audience: "developer", offer: true }, as("ann@example.com"))).resolves.toEqual({
        audience: "maker",
        adopted: false,
    });
    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "maker", mode: "hands-off" });
});

test("an offer meets a kept choice and changes nothing", async () => {
    const routes = routesOn("hands-on");
    await call(routes.setAudience, { audience: "maker" }, as("ann@example.com"));

    await expect(call(routes.setAudience, { audience: "developer", offer: true }, as("ann@example.com"))).resolves.toEqual({
        audience: "maker",
        adopted: false,
        override: "maker",
    });
});

/* THE ONE THAT MATTERS: two people on one sandbox each keep their own words. */
test("one member's choice is never another's", async () => {
    const routes = routesOn("hands-on");
    await call(routes.setAudience, { audience: "maker" }, as("ann@example.com"));

    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "maker", mode: "hands-on", override: "maker" });
    await expect(call(routes.audience, undefined, as("owner@example.com"))).resolves.toEqual({ audience: "developer", mode: "hands-on" });
    // A sandbox nobody signs in to has its one person, apart from both.
    await expect(call(routes.audience, undefined, as(undefined))).resolves.toEqual({ audience: "developer", mode: "hands-on" });
});
