import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Automation, type Capability, SandboxSettingsSchema, ZoneSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { test, expect } from "bun:test";
import { SETTLES, waitFor } from "@intentic/testing/bun";
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

// A schedule's promise is a wall clock, not an epoch: the epoch moves with the date, "20:43 in Warsaw" does not.
const wallClockIn = (tz: string, at: number): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);

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
        // Read by the cron half of upsert: "has a next run" is only answerable against a clock, so the route resolves
        // the zone the schedule would fire in before judging it.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
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
    await waitFor(async () => expect((await services.automations.get("dentist"))?.runs).toHaveLength(1), SETTLES);
    expect((await services.automations.get("dentist"))?.runs[0]?.outcome).toBe("skipped");
});

// THE REPORTED BUG, pinned at the seam it crossed. The dialog turns "20:43" into `43 20 * * *` and sends it; the
// daemon runs in a UTC container. Evaluated bare, that cron means 20:43 UTC — 22:43 in Warsaw — so a schedule set for
// the evening read as two hours away, and every screen showed a plausible number for the wrong moment.
test("a schedule fires on the wall clock of its own zone, not the container's", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    // Through the schema rather than cast: a zone this repo cannot resolve should fail the fixture, not the assertion.
    const tz = ZoneSchema.parse("Europe/Warsaw");
    await call(routes.upsert, automation("evening", { kind: "schedule", cron: "43 20 * * *", tz }), { context });

    const { automations } = await call(routes.list, {}, { context });
    const nextRun = automations.find((a) => a.id === "evening")?.nextRun;
    expect(nextRun).toEqual(expect.any(Number));
    // Asserted as a wall clock IN THAT ZONE rather than as an epoch, since the epoch is what changes with the date and
    // the wall clock is the promise: 20:43 in Warsaw, whatever the container thinks the hour is.
    expect(wallClockIn(tz, nextRun as number)).toBe("20:43");
    // And it is NOT 20:43 UTC, which is the answer the bug gave and the one an unzoned croner still would.
    expect(wallClockIn("UTC", nextRun as number)).not.toBe("20:43");
});

// The sandbox setting is the default behind an automation that names no zone of its own; without it a bare cron falls
// back to the container's UTC, which is the same bug with one fewer place to look.
test("an automation with no zone of its own follows the sandbox's setting", async () => {
    const root = mkdtempSync(join(tmpdir(), "routes-"));
    const services = {
        ...catalogServices(root),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ timezone: "Asia/Tokyo" }),
        }),
    };
    const routes = createAutomationsRoutes(services);
    await call(routes.upsert, automation("morning", { kind: "schedule", cron: "15 9 * * *" }), { context });

    const { automations } = await call(routes.list, {}, { context });
    const nextRun = automations.find((a) => a.id === "morning")?.nextRun;
    expect(nextRun).toEqual(expect.any(Number));
    expect(wallClockIn("Asia/Tokyo", nextRun as number)).toBe("09:15");
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

test("upsert refuses sender rules on a source that does not identify who is writing: the Visitor chat", async () => {
    const services = catalogServices(mkdtempSync(join(tmpdir(), "routes-")));
    const routes = createAutomationsRoutes(services);
    const guest = { ...automation("guest", { kind: "listener", provider: "webchat", allowedOrigins: ["https://example.com"] }), senders };
    await expect(call(routes.upsert, guest, { context })).rejects.toThrow(/does not identify who is writing/);
    expect(await services.automations.get("guest")).toBeUndefined();
});
