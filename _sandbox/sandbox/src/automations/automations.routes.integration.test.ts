import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createAutomationsRoutes } from "./automations.routes.js";
import { fileAutomationsStore } from "./automations-store.js";

// Run now's REFUSALS, which are the half a by-hand fire can get wrong without anyone noticing — the fire it
// does perform is the e2e suite's (it wants a real daemon behind it). Only the manifest is touched on these
// paths, so the fake stops there.
const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
    });

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/automations" };

const automation = (id: string, trigger: Automation["trigger"]): Automation => ({ id, trigger, prompt: `wake:${id}`, enabled: true });

test("run now refuses a chat listener — by hand there is no message, which is the whole thing it handles", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "routes-")));
    await services.automations.upsert(automation("chat", { kind: "listener", provider: "discord" }));
    const routes = createAutomationsRoutes(services);
    /* Firing this by hand could only wake an agent told to handle the events riding with it and handed none —
     * and that pointless turn would hold the automation's one slot against the real mention arriving behind it,
     * which is exactly how a tested-by-hand listener came to look broken. The sentence names the way to test
     * one instead. */
    await expect(call(routes.run, { id: "chat" }, { context })).rejects.toThrow(/real message/);
    expect((await services.automations.get("chat"))?.runs).toEqual([]);
});

test("run now still refuses an automation that isn't there at all", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    await expect(call(routes.run, { id: "ghost" }, { context })).rejects.toThrow(/no automation/);
});
