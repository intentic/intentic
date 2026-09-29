import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { ProvenCaller } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { createSettingsRoutes } from "./settings.routes.js";

// Which words a person's editor uses is theirs, kept by the sandbox so every device they open it on agrees: the desktop
// app said "Accept" and a browser tab "Land now" for one card while each browser kept its own answer. An answer
// replaces theirs; an offer is a browser handing over what it kept on its own and never overwrites a kept answer, and
// no member's answer is another's.

// A fresh history volume per test, since the answers are a file on it.
const routesOnFreshVolume = () =>
    createSettingsRoutes(
        unstubbed<Services>("services", {
            config: unstubbed<Services["config"]>("config", { historyRoot: mkdtempSync(join(tmpdir(), "member-audience-")) }),
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

test("nobody has answered until somebody does", async () => {
    const routes = routesOnFreshVolume();

    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({});
});

test("a person's first offer is kept, and read back on their next device", async () => {
    const routes = routesOnFreshVolume();

    await expect(call(routes.setAudience, { audience: "maker", offer: true }, as("ann@example.com"))).resolves.toEqual({
        audience: "maker",
        adopted: true,
    });
    await expect(call(routes.audience, undefined, as("Ann@Example.com"))).resolves.toEqual({ audience: "maker" });
});

test("an offer meets that person's kept answer and changes nothing", async () => {
    const routes = routesOnFreshVolume();
    await call(routes.setAudience, { audience: "maker", offer: true }, as("ann@example.com"));

    await expect(call(routes.setAudience, { audience: "developer", offer: true }, as("ann@example.com"))).resolves.toEqual({
        audience: "maker",
        adopted: false,
    });
    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "maker" });
});

test("an answer replaces that person's own", async () => {
    const routes = routesOnFreshVolume();
    await call(routes.setAudience, { audience: "maker" }, as("ann@example.com"));

    await expect(call(routes.setAudience, { audience: "developer" }, as("ann@example.com"))).resolves.toEqual({
        audience: "developer",
        adopted: true,
    });
    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "developer" });
});

/* THE ONE THAT MATTERS: two people on one sandbox each keep their own words. */
test("one member's answer is never another's", async () => {
    const routes = routesOnFreshVolume();
    await call(routes.setAudience, { audience: "developer" }, as("owner@example.com"));
    await call(routes.setAudience, { audience: "maker", offer: true }, as("ann@example.com"));

    await expect(call(routes.audience, undefined, as("owner@example.com"))).resolves.toEqual({ audience: "developer" });
    await expect(call(routes.audience, undefined, as("ann@example.com"))).resolves.toEqual({ audience: "maker" });
    // A sandbox nobody signs in to has its one person, apart from both.
    await expect(call(routes.audience, undefined, as(undefined))).resolves.toEqual({});
});
