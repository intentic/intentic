import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "@intentic/constants";
import { AutomationCatalogSchema, type Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { postJson } from "../route-client.testing.js";
import { services as routeServices } from "../route-services.testing.js";
import { memoryAutomationsStore } from "../route-stores.testing.js";
import { testConfig } from "../testing.js";
import { readWorkspaceFile } from "../workspace/workspace-files.js";
import { automationCatalog, CORE_AUTOMATION_TEMPLATES, CORE_TRIGGER_SOURCES, triggerSourceEvents } from "./catalog.js";

const execFileAsync = promisify(execFile);

/* The catalogue is the ONE list the composer draws and `upsert` validates against, so what it is checked for is
 * exactly the two ways that pairing used to break: an area could not add itself, and a disabled area took the
 * automation standing on it down with it. */

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
    // The chore book's scheduled forms are generated, so the count is not asserted: that they arrive at all is.
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
    // And `upsert` will accept exactly what the editor can now offer.
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

/* THE SWITCH CUTS THE TWO HALVES DIFFERENTLY, and that asymmetry is the point: a source has to survive being
 * switched off so the automation standing on it stays readable and editable, while a template is a thing you
 * have not made yet and offering one from a switched-off pack offers a row that cannot fire. */
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
    // Off means off: the editor may still DESCRIBE a stored `rooms` trigger, and `upsert` still refuses a new one.
    expect(triggerSourceEvents(catalog).has("rooms")).toBe(false);
});

test("a template whose trigger would not survive upsert is dropped rather than offered", async () => {
    const baked = mkdtempSync(join(tmpdir(), "catalog-baked-"));
    await writeManifest(
        join(baked, "acme.rooms"),
        pack("rooms", {
            automationTemplates: [
                { id: "good", title: "Nightly", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "Sweep." },
                // `workspace` names an event vocabulary the daemon owns; "whenever" is not in it.
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

/* THROUGH THE REAL ROUTER, once: the merge above is a function, and a function nobody can reach is a function
 * that does not exist. This also pins the other half of the promise: the picker and `upsert` read ONE list, so
 * a provider the catalogue does not carry is refused rather than stored to fail at fire time. */
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
        enabled: true,
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("unknown listener provider");
});

/* ---- the dreaming session's guard, RUN ------------------------------------------------------------------
 *
 * Every other template's guard is prose in a string until some sandbox fires it at 5am with nobody watching.
 * This one decides whether its row EVER fires, and it does so by reading a file this package does not own, so
 * it is exercised here against a registry written for the purpose: what it counts, what it refuses to count,
 * and where it reads "last time" from.
 *
 * Skipped where `jq` is missing. The sandbox image has it and the CI image does not, and a guard that only
 * ever runs on the first is better proved there than failed on the second.
 */
const jqInstalled = async (): Promise<boolean> =>
    await execFileAsync("sh", ["-c", "command -v jq"]).then(
        () => true,
        () => false,
    );

const DREAM_REPORT = "/tmp/intentic-dreaming-sessions.json";
const dreamGuard = CORE_AUTOMATION_TEMPLATES.find((template) => template.id === "dreaming-session")?.guard ?? "";

// One conversation as the registry holds it. Only the fields the guard reads are given: it selects on `id`,
// `createdAt` and `origin`, and copies a handful of others into the report if they are there.
const conversation = (id: string, createdAt: number, extra: object = {}): object => ({ id, createdAt, title: id, status: "idle", ...extra });

// The guard, against a registry of exactly these conversations. `HISTORY_ROOT` is the override the daemon's own
// config takes (env.config.ts), which is what lets the fixture stand in for /history.
const runDreamGuard = async (entries: readonly object[], automationId = "dreaming-session"): Promise<{ passed: boolean; said: string }> => {
    const history = mkdtempSync(join(tmpdir(), "dream-history-"));
    await writeFile(join(history, "agents.json"), JSON.stringify(entries));
    return await execFileAsync("sh", ["-c", dreamGuard], { env: { ...process.env, HISTORY_ROOT: history, AUTOMATION_ID: automationId } }).then(
        () => ({ passed: true, said: "" }),
        (error: { stdout?: string; stderr?: string }) => ({ passed: false, said: `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() }),
    );
};

const readDreamReport = async (): Promise<{ since: number; count: number; sessions: { id: string }[] }> =>
    JSON.parse(await readFile(DREAM_REPORT, "utf8")) as { since: number; count: number; sessions: { id: string }[] };

const DAY = 86_400_000;

test.skipIf(!(await jqInstalled()))("the dreaming guard waits for the sessions to accumulate, and says how far off it is", async () => {
    const enough = Array.from({ length: 30 }, (_, index) => conversation(`swift-otter-${index}`, DAY + index));

    expect(await runDreamGuard(enough.slice(0, 29))).toMatchObject({
        passed: false,
        said: "29 sessions since the last dreaming session, and the bar is 30",
    });
    expect(await runDreamGuard(enough)).toMatchObject({ passed: true });
    // What the woken turn opens: the count it was woken by, and the sessions themselves, newest first.
    const report = await readDreamReport();
    expect(report.count).toBe(30);
    expect(report.sessions[0]?.id).toBe("swift-otter-29");
});

test.skipIf(!(await jqInstalled()))("the fleet's own wakes never push the counter up", async () => {
    // Everything an automation opened, by either of the two marks it leaves: the minted `a-<automation>-` name
    // every fire carries (scheduler.ts mintConversationId), and the origin a dispatcher-born wake records.
    const wakes = [
        ...Array.from({ length: 40 }, (_, index) => conversation(`a-front-desk-${index}`, DAY + index)),
        ...Array.from({ length: 40 }, (_, index) =>
            conversation(`wc-front-desk-visitor-${index}`, DAY + index, { origin: { automationId: "front-desk", provider: "webchat" } }),
        ),
    ];

    expect(await runDreamGuard(wakes)).toMatchObject({ passed: false, said: "0 sessions since the last dreaming session, and the bar is 30" });
});

test.skipIf(!(await jqInstalled()))("last time is read from the conversation the last dream opened, not from a run history that rolls", async () => {
    const dreamedAt = 100 * DAY;
    const registry = [
        conversation("a-dreaming-session-mabc", dreamedAt),
        // Before the last dream: reviewed once already, and never counted again however long the row then skips.
        ...Array.from({ length: 40 }, (_, index) => conversation(`old-session-${index}`, dreamedAt - DAY + index)),
        ...Array.from({ length: 5 }, (_, index) => conversation(`new-session-${index}`, dreamedAt + DAY + index)),
    ];

    expect(await runDreamGuard(registry)).toMatchObject({ passed: false, said: "5 sessions since the last dreaming session, and the bar is 30" });
    expect((await readDreamReport()).since).toBe(dreamedAt);
    // The mark is this row's own: a rename makes it a different automation, whose first night starts from scratch.
    expect(await runDreamGuard(registry, "dreaming-session-2")).toMatchObject({ passed: true });
    expect((await readDreamReport()).count).toBe(45);
});
