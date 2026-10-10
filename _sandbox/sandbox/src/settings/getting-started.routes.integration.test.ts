import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { ProvenCaller } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { createSettingsRoutes } from "./settings.routes.js";

// What a person said about the getting-started checklist is theirs, kept by the sandbox so every device they open it on
// agrees, and never another member's: one member putting it away must not take it off a teammate's screen.

const routesOnFreshVolume = () =>
    createSettingsRoutes(
        unstubbed<Services>("services", {
            config: unstubbed<Services["config"]>("config", { historyRoot: mkdtempSync(join(tmpdir(), "member-getting-started-")) }),
        }),
    );

const as = (email: string | undefined) => {
    const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/settings/getting-started" };
    if (email !== undefined) {
        const identity: ProvenCaller = { email, role: "maintainer", methods: ["google"] };
        context.identity = identity;
    }
    return { context };
};

test("nobody has said anything until somebody does", async () => {
    const routes = routesOnFreshVolume();

    await expect(call(routes.gettingStarted, undefined, as("ann@example.com"))).resolves.toEqual({});
});

test("a person's choices are read back on their next device, and only theirs", async () => {
    const routes = routesOnFreshVolume();

    await expect(call(routes.setGettingStarted, { hidden: true, skipped: ["work", "work"] }, as("ann@example.com"))).resolves.toEqual({
        hidden: true,
        skipped: ["work"],
    });
    await expect(call(routes.gettingStarted, undefined, as("Ann@Example.com"))).resolves.toEqual({ hidden: true, skipped: ["work"] });
    await expect(call(routes.gettingStarted, undefined, as("bob@example.com"))).resolves.toEqual({});
});

test("bringing the checklist back and passing nothing over leaves nothing kept", async () => {
    const routes = routesOnFreshVolume();
    await call(routes.setGettingStarted, { hidden: true }, as("ann@example.com"));

    await expect(call(routes.setGettingStarted, { hidden: false, skipped: [] }, as("ann@example.com"))).resolves.toEqual({});
    await expect(call(routes.gettingStarted, undefined, as("ann@example.com"))).resolves.toEqual({});
});

test("the loopback caller, with no address, keeps choices of its own", async () => {
    const routes = routesOnFreshVolume();
    await call(routes.setGettingStarted, { skipped: ["models"] }, as(undefined));

    await expect(call(routes.gettingStarted, undefined, as(undefined))).resolves.toEqual({ skipped: ["models"] });
    await expect(call(routes.gettingStarted, undefined, as("ann@example.com"))).resolves.toEqual({});
});
