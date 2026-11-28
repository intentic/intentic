import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { AutomationCatalogSchema } from "@intentic/sandbox-contract/schemas/automations";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { unstubbed } from "@intentic/testing";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { postJson } from "../harness/route-client.testing.js";
import { services as routeServices } from "../harness/route-services.testing.js";
import { memoryAutomationsStore } from "./automations-slice.testing.js";
import { testConfig } from "../env.config.testing.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { automationCatalog, CORE_TRIGGER_SOURCES, triggerSourceEvents } from "./catalog.js";
import { wakeSourceFor } from "./fire/wake-source.js";

// Pins that the composer's source list and `upsert`'s trigger validation read the same catalogue: a source can add
// itself, and a disabled source still blocks new triggers on it.

const services = (root: string, extensionsDir: string): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async (): Promise<Capability[]> => [] }),
        config: { ...testConfig, extensionsDir },
    });

const writeManifest = async (dir: string, body: object): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(body));
};

const writeEnablement = async (root: string, body: Record<string, boolean>): Promise<void> => {
    await mkdir(join(root, STATE_DIR, "config"), { recursive: true });
    await writeFile(join(root, STATE_DIR, "config", "extension-enablement.json"), JSON.stringify(body));
};

const pack = (name: string, contributes: object): object => ({
    publisher: "acme",
    name,
    version: "1.0.0",
    icon: "bell",
    engines: { intentic: "^2.0.0" },
    contributes,
});

const ROOMS = {
    provider: "rooms",
    events: [{ type: "message", label: "Messages" }],
    automation: {
        label: "Rooms",
        channel: { label: "Room (optional)", placeholder: "every room" },
        starterPrompt: "Someone posted in a room.",
    },
};

test("serves the daemon's own sources with no extension installed at all", async () => {
    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), ""));

    expect(catalog.sources.map((source) => source.provider)).toEqual(CORE_TRIGGER_SOURCES.map((source) => source.provider));
    // No template comes from the core: since the Visitor chat moved out (2026-11-26) every one is an extension's.
    expect(catalog.templates).toEqual([]);
    expect(catalog.watchKinds).toEqual([]);
});

const RELEASES = {
    id: "github-release",
    label: "GitHub release",
    description: "The newest release of a repository.",
    sentence: "GitHub releases of {repo}[ (prereleases too){prereleases}]",
    fields: [
        { key: "repo", label: "Repository", required: true, pattern: "^[\\w.-]+/[\\w.-]+$", patternHint: "owner/name" },
        { key: "prereleases", label: "Prereleases too", type: "switch" },
    ],
};

const withBackend = (name: string, contributes: object, permissions: object = {}) => ({ ...pack(name, contributes), server: "dist/server.js", permissions });

test("a manifest template with every field the daemon's own carry is offered as declared", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.forge"),
        withBackend(
            "forge",
            {
                watchKinds: [RELEASES],
                automationTemplates: [
                    {
                        id: "nightly-dream",
                        title: "Nightly",
                        trigger: { kind: "schedule", cron: "0 5 * * *", tz: "Europe/Warsaw", afterSessions: 30 },
                        prompt: "Dream.",
                        chore: true,
                        offer: "create",
                    },
                    { id: "signed-hook", title: "Signed", trigger: { kind: "event", dailyMax: 10, signature: { scheme: "github", secret: "HOOK_SECRET" } }, prompt: "Read it." },
                    { id: "reminder", title: "Once", trigger: { kind: "once", at: 4_102_444_800_000 }, prompt: "Remind." },
                    {
                        id: "releases",
                        title: "Releases",
                        trigger: { kind: "schedule", cron: "41 */6 * * *" },
                        source: { kind: "github-release", repo: "oven-sh/bun", prereleases: true },
                        fireOn: "change",
                        until: "first-fire",
                        target: { kind: "notify" },
                        prompt: "A release.",
                    },
                    { id: "own-handler", title: "Own", trigger: { kind: "schedule", cron: "0 * * * *" }, target: { kind: "extension", extension: "acme.forge", handler: "sweep" }, prompt: "Sweep." },
                    // Only the extension a target names saves one pointed at its code: one naming another is never offered.
                    { id: "foreign-handler", title: "Foreign", trigger: { kind: "schedule", cron: "0 * * * *" }, target: { kind: "extension", extension: "acme.other", handler: "sweep" }, prompt: "Sweep." },
                ],
            },
            { fires: ["sweep"] },
        ),
    );

    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked));

    const byId = new Map(catalog.templates.map((template) => [template.id, template]));
    expect(byId.get("nightly-dream")).toMatchObject({ trigger: { kind: "schedule", cron: "0 5 * * *", tz: "Europe/Warsaw", afterSessions: 30 }, chore: true, offer: "create" });
    expect(byId.get("signed-hook")?.trigger).toEqual({ kind: "event", dailyMax: 10, signature: { scheme: "github", secret: "HOOK_SECRET" } });
    expect(byId.get("reminder")?.trigger).toEqual({ kind: "once", at: 4_102_444_800_000 });
    expect(byId.get("releases")).toMatchObject({
        source: { kind: "github-release", repo: "oven-sh/bun", prereleases: true },
        fireOn: "change",
        until: "first-fire",
        target: { kind: "notify" },
    });
    expect(byId.get("own-handler")?.target).toEqual({ kind: "extension", extension: "acme.forge", handler: "sweep" });
    expect(byId.has("foreign-handler")).toBe(false);
    expect(catalog.watchKinds?.map((kind) => [kind.id, kind.extension, kind.enabled])).toEqual([["github-release", "acme.forge", true]]);
});

test("a watch template is offered only while an enabled extension checks its kind, and only with parameters that kind takes", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-work-"));
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(join(baked, "acme.forge"), withBackend("forge", { watchKinds: [RELEASES] }));
    await writeManifest(
        join(baked, "acme.chores"),
        pack("chores", {
            automationTemplates: [
                { id: "watch-forge", title: "Releases", trigger: { kind: "schedule", cron: "0 * * * *" }, source: { kind: "github-release", repo: "a/b" }, prompt: "Read." },
                { id: "misnamed", title: "Bad", trigger: { kind: "schedule", cron: "0 * * * *" }, source: { kind: "github-release", repository: "a/b" }, prompt: "Read." },
                { id: "nobody", title: "None", trigger: { kind: "schedule", cron: "0 * * * *" }, source: { kind: "pypi", package: "x" }, prompt: "Read." },
            ],
        }),
    );

    const on = await automationCatalog(services(root, baked));
    expect(on.templates.filter((template) => template.source !== undefined).map((template) => template.id)).toEqual(["watch-forge"]);

    await writeEnablement(root, { "acme.forge": false });
    const off = await automationCatalog(services(root, baked));
    expect(off.templates.some((template) => template.id === "watch-forge")).toBe(false);
    // The kind stays listed, switched off, so a stored watch naming it still reads as what it was.
    expect(off.watchKinds?.map((kind) => [kind.id, kind.enabled])).toEqual([["github-release", false]]);
});

test("no chore template is offered while the extension that declares it is off, and no core one stands in for it", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-work-"));
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.upkeep"),
        pack("upkeep", { automationTemplates: [{ id: "sweep-deps", title: "Sweep", trigger: { kind: "schedule", cron: "0 3 * * 1" }, prompt: "Sweep.", chore: true, offer: "create" }] }),
    );
    expect((await automationCatalog(services(root, baked))).templates.filter((template) => template.chore === true).map((template) => template.id)).toEqual(["sweep-deps"]);

    await writeEnablement(root, { "acme.upkeep": false });
    expect((await automationCatalog(services(root, baked))).templates.filter((template) => template.chore === true)).toEqual([]);
});

test("an installed pack's listener source and templates join the catalogue without the surface knowing it exists", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.rooms"),
        pack("rooms", {
            listener: ROOMS,
            automationTemplates: [
                {
                    id: "room-mention",
                    title: "Answer a room mention",
                    requires: ["rooms"],
                    trigger: { kind: "listener", provider: "rooms", eventType: "message" },
                    prompt: "Answer the room politely.",
                },
            ],
        }),
    );

    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked));

    const rooms = catalog.sources.find((source) => source.provider === "rooms");
    expect(rooms).toMatchObject({ label: "Rooms", icon: "bell", enabled: true });
    expect(catalog.templates.find((template) => template.id === "room-mention")?.requires).toEqual(["rooms"]);
    expect(triggerSourceEvents(catalog).get("rooms")).toEqual(new Set(["message"]));
});

test("a branch filter and a mention filter are drawn only where the source declares one", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.rooms"),
        pack("rooms", {
            listener: {
                ...ROOMS,
                automation: {
                    ...ROOMS.automation,
                    mentionLabel: "Only when addressed",
                    branchField: { label: "Branch", placeholder: "every branch", hint: "Exact match." },
                    sender: { label: "Member ID", placeholder: "a member's id" },
                    senderGroup: { label: "Team ID", placeholder: "a team's id" },
                },
            },
        }),
    );

    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked));

    const rooms = catalog.sources.find((source) => source.provider === "rooms");
    expect(rooms?.mentionLabel).toBe("Only when addressed");
    expect(rooms?.branchField?.hint).toBe("Exact match.");
    expect(rooms?.sender?.label).toBe("Member ID");
    expect(rooms?.senderGroup?.label).toBe("Team ID");
    const ci = catalog.sources.find((source) => source.provider === "ci");
    // CI vouches for nobody's identity, which is what keeps sender rules off it; of the daemon's own, only s2s does.
    expect(ci?.sender).toBeUndefined();
});

test("a disabled pack keeps its source listed and loses its templates", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-work-"));
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.rooms"),
        pack("rooms", {
            listener: ROOMS,
            automationTemplates: [
                { id: "room-mention", title: "Answer a room mention", trigger: { kind: "listener", provider: "rooms" }, prompt: "Answer." },
            ],
        }),
    );
    await writeEnablement(root, { "acme.rooms": false });

    const catalog = await automationCatalog(services(root, baked));

    expect(catalog.sources.find((source) => source.provider === "rooms")).toMatchObject({ label: "Rooms", enabled: false });
    expect(catalog.templates.some((template) => template.id === "room-mention")).toBe(false);
    expect(triggerSourceEvents(catalog).has("rooms")).toBe(false);
});

test("a template whose trigger would not survive upsert is dropped rather than offered", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.rooms"),
        pack("rooms", {
            automationTemplates: [
                { id: "good", title: "Nightly", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "Sweep." },
                // `workspace` events come from a fixed vocabulary; "whenever" is not one of them.
                { id: "bad", title: "Whenever", trigger: { kind: "workspace", event: "whenever" }, prompt: "Do something." },
            ],
        }),
    );

    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked));

    expect(catalog.templates.some((template) => template.id === "good")).toBe(true);
    expect(catalog.templates.some((template) => template.id === "bad")).toBe(false);
});

test("an extension cannot shadow one of the daemon's own sources", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.ci"),
        pack("ci", { listener: { ...ROOMS, provider: "ci", automation: { ...ROOMS.automation, label: "Not CI" } } }),
    );

    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked));

    expect(catalog.sources.filter((source) => source.provider === "ci")).toHaveLength(1);
    expect(catalog.sources.find((source) => source.provider === "ci")?.label).toBe("CI/CD");
});

test("the catalogue is served, and upsert refuses a provider it does not carry", async () => {
    const app = createApp(routeServices({ automations: memoryAutomationsStore([]) }));

    const served = await app.request("/automations/catalog");
    expect(served.status).toBe(200);
    const catalog = AutomationCatalogSchema.parse(await served.json());
    expect(catalog.sources.map((source) => source.provider)).toContain("ci");

    const refused = await postJson(app, "/automations", {
        id: "rooms-watch",
        trigger: { kind: "listener", provider: "rooms" },
        prompt: "Answer the room.",
        models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
        enabled: true,
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("unknown listener provider");
});

// (2026-11-26) A source anyone on the internet reaches says so, and its wakes are held to the owner's floor for strangers
// by that declaration alone (wake-source.ts), never by a table of provider names.
test("a listener declaring strangers carries it into the catalogue and holds its wakes to that floor", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(join(baked, "acme.crashes"), pack("crashes", { listener: { ...ROOMS, provider: "crashes", strangers: "report" } }));
    await writeManifest(join(baked, "acme.rooms"), pack("rooms", { listener: ROOMS }));
    const host = services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked);

    const catalog = await automationCatalog(host);

    expect(catalog.sources.find((source) => source.provider === "crashes")?.strangers).toBe("report");
    expect(catalog.sources.find((source) => source.provider === "rooms")).not.toHaveProperty("strangers");
    expect(await wakeSourceFor(host, { kind: "listener", provider: "crashes" })).toBe("issues");
    expect(await wakeSourceFor(host, { kind: "listener", provider: "rooms" })).toBe("listener");
});

// (2026-11-26) The Visitor chat's `webchat` source is the visitor-chat extension's listener now, under the same provider,
// so a stored chat reads unchanged and its wakes keep the website visitor's floor through that extension's declaration.
test("the Visitor chat's source comes from the extension that declares it, with the website visitor's floor", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(join(baked, "intentic.visitor-chat"), pack("visitor-chat", { listener: { ...ROOMS, provider: "webchat", strangers: "visitor" } }));
    const host = services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked);

    expect(CORE_TRIGGER_SOURCES.map((source) => source.provider)).not.toContain("webchat");
    expect((await automationCatalog(host)).sources.find((source) => source.provider === "webchat")?.strangers).toBe("visitor");
    expect(await wakeSourceFor(host, { kind: "listener", provider: "webchat" })).toBe("webchat");
    // Nobody declares this provider at all: a team chat's floor.
    expect(await wakeSourceFor(host, { kind: "listener", provider: "nobody" })).toBe("listener");
});

// (2026-11-26) The bug intake's `issues` source is the issues extension's listener now, under the same provider, so a
// stored intake reads unchanged and its wakes keep the bug-report floor through that extension's declaration.
test("the issues source comes from the extension that declares it, with the bug-report floor", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(join(baked, "intentic.issues"), pack("issues", { listener: { ...ROOMS, provider: "issues", strangers: "report" } }));
    const host = services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked);

    expect(CORE_TRIGGER_SOURCES.map((source) => source.provider)).not.toContain("issues");
    expect((await automationCatalog(host)).sources.find((source) => source.provider === "issues")?.strangers).toBe("report");
    expect(await wakeSourceFor(host, { kind: "listener", provider: "issues" })).toBe("issues");
});

// (2026-11-27) What other sandboxes send is the daemon's own source, and no extension can relabel it: a contact request
// answers to the contact floor, what only an accepted contact sends to the team chat's.
test("the daemon's s2s source holds a stranger's contact request to the contact floor, and an accepted contact's message to a team chat's", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(join(baked, "acme.s2s"), pack("s2s", { listener: { ...ROOMS, provider: "s2s" } }));
    const host = services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked);

    const catalog = await automationCatalog(host);

    expect(catalog.sources.filter((source) => source.provider === "s2s").map((source) => [source.label, source.strangers])).toEqual([
        ["Messages from sandboxes", "contact"],
    ]);
    expect(triggerSourceEvents(catalog).get("s2s")).toEqual(new Set(["message", "report", "contact.request", "task.request"]));
    expect(await wakeSourceFor(host, { kind: "listener", provider: "s2s" })).toBe("contact");
    expect(await wakeSourceFor(host, { kind: "listener", provider: "s2s", eventType: "contact.request" })).toBe("contact");
    expect(await wakeSourceFor(host, { kind: "listener", provider: "s2s", eventType: "message" })).toBe("listener");
});

test("a switched-off extension's stranger declaration holds nothing, since its listener fires nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-work-"));
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(join(baked, "acme.crashes"), pack("crashes", { listener: { ...ROOMS, provider: "crashes", strangers: "visitor" } }));
    await writeEnablement(root, { "acme.crashes": false });

    expect(await wakeSourceFor(services(root, baked), { kind: "listener", provider: "crashes" })).toBe("listener");
});
