import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { AutomationCatalogSchema, type Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { postJson } from "../harness/route-client.testing.js";
import { services as routeServices } from "../harness/route-services.testing.js";
import { memoryAutomationsStore } from "../harness/route-stores.testing.js";
import { testConfig } from "../testing.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { automationCatalog, CORE_TRIGGER_SOURCES, triggerSourceEvents } from "./catalog.js";

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
    expect(catalog.templates.some((template) => template.id === "front-desk")).toBe(true);
    expect(catalog.templates.some((template) => template.id === "fix-failing-ci")).toBe(true);
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
                },
            },
        }),
    );

    const catalog = await automationCatalog(services(mkdtempSync(join(tmpdir(), "catalog-work-")), baked));

    const rooms = catalog.sources.find((source) => source.provider === "rooms");
    expect(rooms?.mentionLabel).toBe("Only when addressed");
    expect(rooms?.branchField?.hint).toBe("Exact match.");
    expect(catalog.sources.find((source) => source.provider === "webchat")?.branchField).toBeUndefined();
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
