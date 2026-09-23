import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionApiVersion } from "@intentic/extension-api/protocol";
import { test, expect } from "bun:test";

import { createApp } from "../app.js";

import { workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";

import { listenerProvidersOf } from "./installed-extensions.js";

import { workspacePaths } from "../workspace/workspace.js";

import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { testConfig } from "../testing.js";

// Extensions routes, driven over the daemon's HTTP surface exactly as the browser does.
// Fakes and the client are shared (route-services.testing.ts and its siblings).

// A workspace with its own history root, where the owner's approvals of its extensions live, so none leaks between tests.
const ownHistory = (prefix: string): { readonly workspace: ReturnType<typeof workspacePaths>; readonly svc: ReturnType<typeof services> } => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), prefix)));
    return { workspace, svc: services({ workspace, config: { ...testConfig, historyRoot: mkdtempSync(join(tmpdir(), `${prefix}history-`)) } }) };
};

test("extensions.setEnabled keeps the extension listed, switches it off, and unwires it daemon-side", async () => {
    // Real workspace root: the switch persists to .intentic/config/extension-enablement.json.
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-toggle-")));
    const svc = services({ workspace });
    const client = clientFor(createApp(svc));

    const listed = async (): Promise<Record<string, boolean>> =>
        Object.fromEntries((await client.extensions.list()).extensions.map((extension) => [extension.id, extension.enabled]));

    expect((await listed())["intentic.discord"]).toBe(true);
    expect((await listenerProvidersOf(svc)).get("discord")).toEqual(new Set(["message", "voice_utterance", "voice_transcript"]));

    await client.extensions.setEnabled({ id: "intentic.discord", enabled: false });

    expect((await listed())["intentic.discord"]).toBe(false);
    expect((await listenerProvidersOf(svc)).has("discord")).toBe(false);
    expect(await errorCode(client.extensions.processStart({ id: "intentic.discord", name: "gateway" }))).toBe("PRECONDITION_FAILED");

    await client.extensions.setEnabled({ id: "intentic.discord", enabled: true });
    expect((await listed())["intentic.discord"]).toBe(true);
});

test("an essential extension cannot be switched off, reads enabled over a stale entry, and says so on its row", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-essential-")));
    // Simulates a disabled entry written before essential existed (or by hand); it must not keep the surface shut.
    await mkdir(join(workspace.root, ".intentic/config"), { recursive: true });
    await writeFile(join(workspace.root, ".intentic/config/extension-enablement.json"), JSON.stringify({ "intentic.automations": false }));
    const client = clientFor(createApp(services({ workspace })));

    const rows = (await client.extensions.list()).extensions;
    const automations = rows.find((extension) => extension.id === "intentic.automations");
    expect(automations).toMatchObject({ enabled: true, essential: true });

    expect(await errorCode(client.extensions.setEnabled({ id: "intentic.automations", enabled: false }))).toBe("BAD_REQUEST");
    await client.extensions.setEnabled({ id: "intentic.automations", enabled: true });

    const essentials = rows.filter((extension) => extension.essential === true).map((extension) => extension.id);
    // Maintenance is not here: its probe sweep follows its own switch, and the extension is listed rather than baked.
    expect(essentials.toSorted()).toEqual(["intentic.automations", "intentic.workflows"]);
});

test("a workspace extension waits for approval, then lists like any other and serves its bundle by content hash", async () => {
    const { workspace, svc } = ownHistory("ext-workspace-");
    const dir = join(workspaceExtensionsRoot(workspace.root), "hello");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "acme", name: "hello", version: "1.0.0", engines: { intentic: "^0.2.0" }, entry: "dist/index.js" }),
    );
    await writeFile(join(dir, "dist", "index.js"), "export const activate = () => {};");
    await mkdir(join(workspaceExtensionsRoot(workspace.root), "scratch"), { recursive: true });

    const app = createApp(svc);
    const client = clientFor(app);
    const waiting = await client.extensions.list();
    expect(waiting.extensions.find((extension) => extension.id === "acme.hello")).toBeUndefined();
    expect(waiting.pending).toEqual([
        {
            id: "acme.hello",
            dir: "hello",
            manifest: expect.objectContaining({ publisher: "acme", name: "hello" }),
            powers: { added: ["runs a UI bundle in your browser"], removed: [], unchanged: [] },
            approvedBefore: false,
            digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
    ]);
    // Nothing of it reaches a browser before the yes.
    expect((await app.request("/extensions/acme.hello/bundle")).status).toBe(404);
    await client.extensions.approve({ id: "acme.hello", digest: waiting.pending[0]?.digest ?? "" });

    const list = await client.extensions.list();
    expect(list.pending).toEqual([]);
    expect(list.extensions.find((extension) => extension.id === "acme.hello")).toMatchObject({
        source: "workspace",
        commit: "workspace",
        enabled: true,
    });
    expect(list.invalid).toEqual([{ dir: "scratch", error: expect.stringContaining("no intentic-extension.json") }]);

    const bundle = await app.request("/extensions/acme.hello/bundle");
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).toBe("export const activate = () => {};");
    const etag = bundle.headers.get("etag") ?? "";
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect((await app.request("/extensions/acme.hello/bundle", { headers: { "if-none-match": etag } })).status).toBe(304);
    await writeFile(join(dir, "dist", "index.js"), "export const activate = () => { /* v2 */ };");
    expect((await app.request("/extensions/acme.hello/bundle", { headers: { "if-none-match": etag } })).status).toBe(200);
});

test("the extension list carries every first-party extension, compiled-in UI ones included", async () => {
    const client = clientFor(createApp(services({ workspace: workspacePaths(mkdtempSync(join(tmpdir(), "ext-list-"))) })));
    const ids = (await client.extensions.list()).extensions.map((extension) => extension.id).toSorted();
    // The INCLUDED set only. acceptance, deployments, documentation, issues, knowledge, maintenance and logs are
    // first-party extensions in their own repositories, listed in the registry: a sandbox is itself without them.
    expect(ids).toEqual([
        "intentic.acp-agents",
        "intentic.activity",
        "intentic.approvals",
        "intentic.automations",
        "intentic.browsers",
        "intentic.connectors",
        "intentic.devices",
        "intentic.discord",
        "intentic.git-history",
        "intentic.google-workspace",
        "intentic.imap",
        "intentic.onlyoffice",
        "intentic.pi-agent",
        "intentic.pipelines",
        "intentic.preview",
        "intentic.projects",
        "intentic.repo-apps",
        "intentic.slack",
        "intentic.social",
        "intentic.telegram",
        "intentic.viewers",
        "intentic.whatsapp",
        "intentic.workflows",
    ]);
});

test("extensions.create writes a workspace extension that is listed, enabled and runnable with no build step", async () => {
    const app = createApp(ownHistory("ext-create-").svc);
    const client = clientFor(app);

    const created = await client.extensions.create({ publisher: "workspace", name: "release-notes" });
    expect(created).toEqual({ id: "workspace.release-notes", dir: ".intentic/config/workspace-extensions/release-notes" });

    const listed = (await client.extensions.list()).extensions.find((extension) => extension.id === "workspace.release-notes");
    expect(listed).toMatchObject({ source: "workspace", enabled: true });
    expect(listed?.manifest.permissions).toBeUndefined();
    expect(listed?.manifest.engines.intentic).toBe(`^${extensionApiVersion}`);
    expect(listed?.manifest.contributes?.views).toEqual([{ id: "release-notes", label: "Release Notes", surface: "rail" }]);

    const bundle = await app.request("/extensions/workspace.release-notes/bundle");
    expect(bundle.status).toBe(200);
    const source = await bundle.text();
    expect(source).toContain(`export const activate`);
    // Only bare specifiers the import map publishes; a blob URL can't resolve a relative import, so a second file 404s.
    expect([...source.matchAll(/^import .* from "(.*)";$/gmu)].map((match) => match[1])).toEqual(["vue"]);
});

test("extensions.create refuses a name that is already taken, without touching what is there", async () => {
    const { workspace, svc } = ownHistory("ext-create-clash-");
    const client = clientFor(createApp(svc));

    await client.extensions.create({ publisher: "workspace", name: "notes" });
    const entry = join(workspaceExtensionsRoot(workspace.root), "notes", "extension.js");
    await writeFile(entry, "export const activate = () => { /* edited */ };");

    expect(await errorCode(client.extensions.create({ publisher: "workspace", name: "notes" }))).toBe("CONFLICT");
    expect(await readFile(entry, "utf8")).toContain("edited");
});

test("usage is counted per declared route, accumulates across reports, and rides the list", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-usage-")));
    const client = clientFor(createApp(services({ workspace })));
    // First-party extension with a real permissions list, so the filtering manifest is a shipped one.
    const id = "intentic.repo-apps";
    const declared = (await client.extensions.list()).extensions.find((extension) => extension.id === id)?.manifest.permissions?.sandbox ?? [];
    expect(declared.length).toBeGreaterThan(1);
    const [first, second] = declared as [string, string];

    // `usage` is absent, not empty, until observed; that's how a row tells never-exercised from exercised-but-unused.
    expect((await client.extensions.list()).extensions.find((extension) => extension.id === id)?.usage).toBeUndefined();

    await client.extensions.recordUsage({ reports: { [id]: { [first]: 2 } } });
    await client.extensions.recordUsage({ reports: { [id]: { [first]: 3, [second]: 1 } } });

    const usage = (await client.extensions.list()).extensions.find((extension) => extension.id === id)?.usage;
    expect(usage?.[first]?.calls).toBe(5);
    expect(usage?.[second]?.calls).toBe(1);
    expect(Date.parse(usage?.[first]?.last ?? "")).not.toBeNaN();
});

test("usage the manifest no longer declares is dropped, so a removed permission cannot keep answering", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-usage-stale-")));
    const client = clientFor(createApp(services({ workspace })));
    const id = "intentic.repo-apps";
    const declared = (await client.extensions.list()).extensions.find((extension) => extension.id === id)?.manifest.permissions?.sandbox ?? [];
    const [kept] = declared as [string];

    // Simulates a stale browser reporting a route this manifest no longer declares.
    await client.extensions.recordUsage({ reports: { [id]: { [kept]: 1, "DELETE /everything": 9 } } });

    const usage = (await client.extensions.list()).extensions.find((extension) => extension.id === id)?.usage;
    expect(usage?.[kept]?.calls).toBe(1);
    expect(usage?.["DELETE /everything"]).toBeUndefined();
});

test("readiness catches the two failures that are invisible here and fatal once published", async () => {
    const { workspace, svc } = ownHistory("ext-readiness-");
    const client = clientFor(createApp(svc));

    await client.extensions.create({ publisher: "workspace", name: "clean" });
    const clean = await client.extensions.readiness({ id: "workspace.clean" });
    expect(clean.checks.filter((check) => check.status === "fail")).toEqual([]);
    // Passes because the scaffold declares no daemon reach; `warn` is reserved for a declared-but-unexercised route.
    expect(clean.checks.find((check) => check.id === "permissions")).toMatchObject({
        status: "pass",
        detail: "It asks for no daemon routes at all.",
    });

    const dir = join(workspaceExtensionsRoot(workspace.root), "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "workspace", name: "broken", version: "0.1.0", engines: { intentic: "^1.0.0" }, entry: "extension.js" }),
    );
    await writeFile(
        join(dir, "extension.js"),
        `import { h } from "vue";\nimport { thing } from "./helper.js";\nimport axios from "axios";\nexport const activate = () => {};\n`,
    );

    const broken = await client.extensions.readiness({ id: "workspace.broken" });
    const failed = Object.fromEntries(broken.checks.map((check) => [check.id, check]));
    // A relative import can't resolve against the blob URL the bundle loads from; reported before axios is considered.
    expect(failed["bundle"]?.status).toBe("fail");
    expect(failed["bundle"]?.detail).toContain("./helper.js");
    expect(failed["engines"]?.status).toBe("fail");
    expect(failed["engines"]?.detail).toContain("^1.0.0");
});

test("readiness reports a promised file that is not there, for an extension still waiting for approval too", async () => {
    const { workspace, svc } = ownHistory("ext-readiness-paths-");
    const client = clientFor(createApp(svc));
    const dir = join(workspaceExtensionsRoot(workspace.root), "promises");
    await mkdir(dir, { recursive: true });
    // Promises a CLI directory that was never committed; nothing fails here, only later on someone else's machine.
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "workspace", name: "promises", version: "0.1.0", engines: { intentic: "^2.0.0" }, contributes: { bin: "bin" } }),
    );

    const checks = await client.extensions.readiness({ id: "workspace.promises" });
    const paths = checks.checks.find((check) => check.id === "paths");
    expect(paths?.status).toBe("fail");
    expect(paths?.detail).toContain("bin directory (bin)");
});

test("approval is refused for powers that changed since they were shown, and for an extension not waiting", async () => {
    const { workspace, svc } = ownHistory("ext-approve-race-");
    const dir = join(workspaceExtensionsRoot(workspace.root), "grower");
    const manifest = { publisher: "acme", name: "grower", version: "1.0.0", engines: { intentic: "^0.2.0" } };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
    const client = clientFor(createApp(svc));
    const shown = (await client.extensions.list()).pending[0]?.digest ?? "";

    // Grows a backend while the owner reads the old list.
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify({ ...manifest, server: "server.js" }));
    expect(await errorCode(client.extensions.approve({ id: "acme.grower", digest: shown }))).toBe("CONFLICT");
    expect(await errorCode(client.extensions.approve({ id: "intentic.discord", digest: shown }))).toBe("NOT_FOUND");

    const current = (await client.extensions.list()).pending[0];
    expect(current?.powers.added).toEqual(["runs a backend bundle inside the daemon's extension host"]);
    await client.extensions.approve({ id: "acme.grower", digest: current?.digest ?? "" });
    expect((await client.extensions.list()).extensions.some((extension) => extension.id === "acme.grower")).toBe(true);
});
