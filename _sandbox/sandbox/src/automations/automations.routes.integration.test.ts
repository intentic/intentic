import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation, Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { testConfig } from "../testing.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { createAutomationsRoutes } from "./automations.routes.js";
import { fileAutomationsStore } from "./automations-store.js";

// Run now's REFUSALS, which are the half a by-hand fire can get wrong without anyone noticing: the fire it
// does perform is the e2e suite's (it wants a real daemon behind it). Only the manifest is touched on these
// paths, so the fake stops there.
const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
    });

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/automations" };

const automation = (id: string, trigger: Automation["trigger"]): Automation => ({ id, trigger, prompt: `wake:${id}`, models: [{ provider: "claude", model: "claude-sonnet-4-6" }], enabled: true });

test("run now refuses a chat listener: by hand there is no message, which is the whole thing it handles", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "routes-")));
    await services.automations.upsert(automation("chat", { kind: "listener", provider: "discord" }));
    const routes = createAutomationsRoutes(services);
    /* Firing this by hand could only wake an agent told to handle the events riding with it and handed none. */
    await expect(call(routes.run, { id: "chat" }, { context })).rejects.toThrow(/real message/);
    expect((await services.automations.get("chat"))?.runs).toEqual([]);
});

test("run now still refuses an automation that isn't there at all", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    await expect(call(routes.run, { id: "ghost" }, { context })).rejects.toThrow(/no automation/);
});

// Sender rules need a source that vouches for `author.id`; the catalogue says which do. The daemon's own sources never
// declare one, so an empty extensions dir is exactly the case where every listener refuses them.
const catalogServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async (): Promise<Capability[]> => [] }),
        config: { ...testConfig, extensionsDir: join(root, "extensions") },
    });

const senders: Automation["senders"] = { rules: [{ ids: ["u1"] }], others: "ignore" };

test("upsert refuses sender rules on a trigger nobody sends: a schedule", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    const nightly = { ...automation("nightly", { kind: "schedule", cron: "0 3 * * *" }), senders };
    await expect(call(routes.upsert, nightly, { context })).rejects.toThrow(/listens for messages/);
    expect(await services.automations.get("nightly")).toBeUndefined();
});

test("upsert refuses sender rules on a source that does not identify who is writing: the Front Desk", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    const desk = { ...automation("desk", { kind: "listener", provider: "webchat", allowedOrigins: ["https://example.com"] }), senders };
    await expect(call(routes.upsert, desk, { context })).rejects.toThrow(/does not identify who is writing/);
    expect(await services.automations.get("desk")).toBeUndefined();
});
