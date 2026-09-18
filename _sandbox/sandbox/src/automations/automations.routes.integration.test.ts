import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Automation, type Capability, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
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
        // Reached only once a write gets PAST the refusals: a stored automation has its door reconciled, and the
        // listener reconcile that follows it logs rather than throws.
        doorTokens: unstubbed<Services["doorTokens"]>("doorTokens", { ensure: async () => "token", remove: async () => {} }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });

// The one fake that lets a fire actually START and then stop on its own: the workspace refuses clock-started wakes, so
// `runFire` records a skipped run and returns before anything reaches a provider.
const deniedServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ admission: { schedule: "deny" } }),
        }),
        turnJournal: unstubbed<Services["turnJournal"]>("turnJournal", { clearFire: async () => {} }),
    });

const senders: Automation["senders"] = { rules: [{ ids: ["u1"] }], others: "ignore" };

test("upsert refuses sender rules on a trigger nobody sends: a schedule", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    const nightly = { ...automation("nightly", { kind: "schedule", cron: "0 3 * * *" }), senders };
    await expect(call(routes.upsert, nightly, { context })).rejects.toThrow(/listens for messages/);
    expect(await services.automations.get("nightly")).toBeUndefined();
});

// A moment already gone is not a schedule. The tick fires an overdue one-time wake rather than dropping it, so an
// automation arming one would go off on the spot, which is nobody's idea of "at 3pm".
test("upsert refuses a one-time wake whose moment has passed, and takes a future one", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    const gone = automation("dentist", { kind: "once", at: Date.now() - 60_000 });
    await expect(call(routes.upsert, gone, { context })).rejects.toThrow(/already passed/);
    expect(await services.automations.get("dentist")).toBeUndefined();

    const soon = automation("dentist", { kind: "once", at: Date.now() + 3_600_000 });
    await call(routes.upsert, soon, { context });
    expect((await services.automations.get("dentist"))?.trigger).toEqual(soon.trigger);
});

test("the switch cannot re-arm a spent one-time wake; its moment has to be moved first", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    // As the scheduler leaves one it has fired: switched off, with its moment behind it.
    await services.automations.upsert({ ...automation("dentist", { kind: "once", at: Date.now() - 60_000 }), enabled: false });
    await expect(call(routes.setEnabled, { id: "dentist", enabled: false }, { context })).resolves.toEqual({ ok: true });
    await expect(call(routes.setEnabled, { id: "dentist", enabled: true }, { context })).rejects.toThrow(/already passed/);
    expect((await services.automations.get("dentist"))?.enabled).toBe(false);

    // A moment still ahead arms without complaint, which is what says the refusal reads the clock the right way round.
    await services.automations.upsert({ ...automation("standup", { kind: "once", at: Date.now() + 3_600_000 }), enabled: false });
    await expect(call(routes.setEnabled, { id: "standup", enabled: true }, { context })).resolves.toEqual({ ok: true });
    expect((await services.automations.get("standup"))?.enabled).toBe(true);
});

// "Fires once" has to survive the play button too, or pressing it on a reminder delivers it now AND again at its
// moment. The fire it starts is admitted and then refused by the workspace's own admission floor, which is how this
// test watches the retirement without a real agent turn behind it.
test("run now retires a one-time wake exactly as its own moment would have", async () => {
    const services = deniedServices(mkdtempSync(join(tmpdir(), "routes-")));
    await services.automations.upsert(automation("dentist", { kind: "once", at: Date.now() + 3_600_000 }));
    const routes = createAutomationsRoutes(services);
    await call(routes.run, { id: "dentist" }, { context });
    // Retired before the fire is even dispatched, which is what makes a second fire impossible rather than unlikely.
    expect((await services.automations.get("dentist"))?.enabled).toBe(false);
    // The fire itself is detached and outlives the request; the floor is what stopped it, and that reaches the record.
    await vi.waitFor(async () => expect((await services.automations.get("dentist"))?.runs).toHaveLength(1), SETTLES);
    expect((await services.automations.get("dentist"))?.runs[0]?.outcome).toBe("skipped");
});

test("upsert refuses a cron that parses but can never come round", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    // A real date croner accepts as a pattern, and one that is simply not a date: both parse, neither ever fires, and
    // both used to store as an automation that reads armed and never runs.
    await expect(call(routes.upsert, automation("past", { kind: "schedule", cron: "2020-01-01T00:00:00" }), { context })).rejects.toThrow(/no next run/);
    await expect(call(routes.upsert, automation("nonsense", { kind: "schedule", cron: "2026-02-30T10:00:00" }), { context })).rejects.toThrow(
        /no next run/,
    );
    await expect(call(routes.upsert, automation("garbage", { kind: "schedule", cron: "every friday" }), { context })).rejects.toThrow(/invalid cron/);
    expect(await services.automations.get("past")).toBeUndefined();
});

test("upsert refuses sender rules on a source that does not identify who is writing: the Front Desk", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    const desk = { ...automation("desk", { kind: "listener", provider: "webchat", allowedOrigins: ["https://example.com"] }), senders };
    await expect(call(routes.upsert, desk, { context })).rejects.toThrow(/does not identify who is writing/);
    expect(await services.automations.get("desk")).toBeUndefined();
});
