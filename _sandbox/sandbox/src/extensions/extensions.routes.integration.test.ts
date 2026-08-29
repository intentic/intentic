import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionApiVersion } from "@intentic/extension-api/protocol";
import { expect, test } from "vitest";

import { createApp } from "../app.js";

import { workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";

import { listenerProvidersOf } from "./installed-extensions.js";

import { workspacePaths } from "../workspace/workspace.js";

import { clientFor, errorCode, memoryCapabilitiesStore, services } from "../route-testing.js";

/* The extensions routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon:
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("extensions.setEnabled keeps the extension listed, switches it off, and unwires it daemon-side", async () => {
    // A real workspace root, because the switch persists to <root>/.intentic/config/extension-enablement.json. The
    // extensions dir is the repo's own _extensions, so this runs against the shipped first-party manifests.
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-toggle-")));
    const svc = services({ workspace });
    const client = clientFor(createApp(svc));

    const listed = async (): Promise<Record<string, boolean>> =>
        Object.fromEntries((await client.extensions.list()).extensions.map((extension) => [extension.id, extension.enabled]));

    expect((await listed())["intentic.discord"]).toBe(true);
    expect((await listenerProvidersOf(svc)).get("discord")).toEqual(new Set(["message", "voice_utterance", "voice_transcript"]));

    await client.extensions.setEnabled({ id: "intentic.discord", enabled: false });

    // Still listed: that is what keeps the switch reachable, and off.
    expect((await listed())["intentic.discord"]).toBe(false);
    // The listener provider an automations trigger validates against is gone with it, and its declared gateway
    // can no longer be started by hand.
    expect((await listenerProvidersOf(svc)).has("discord")).toBe(false);
    expect(await errorCode(client.extensions.processStart({ id: "intentic.discord", name: "gateway" }))).toBe("PRECONDITION_FAILED");

    // And back on, from the same list the tab renders.
    await client.extensions.setEnabled({ id: "intentic.discord", enabled: true });
    expect((await listed())["intentic.discord"]).toBe(true);
});

/* THE FIXED SWITCHES. Each of these is the only control surface for an engine the daemon runs regardless:
 * the scheduler fires turns whether or not anything draws them, so "off" would not stop anything, only blind
 * the owner to it. The defect this pins: disabling the automations page used to leave every cron, listener and
 * approval firing with no way to see, stop or approve a single one. */
test("an essential extension cannot be switched off, reads enabled over a stale entry, and says so on its row", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-essential-")));
    // A disabled entry written before the concept existed (or by hand): must not keep the surface shut.
    await mkdir(join(workspace.root, ".intentic/config"), { recursive: true });
    await writeFile(join(workspace.root, ".intentic/config/extension-enablement.json"), JSON.stringify({ "intentic.automations": false }));
    const client = clientFor(createApp(services({ workspace })));

    const rows = (await client.extensions.list()).extensions;
    const automations = rows.find((extension) => extension.id === "intentic.automations");
    expect(automations).toMatchObject({ enabled: true, essential: true });

    // The refusal is the backstop for a caller that skipped the tab's fixed switch.
    expect(await errorCode(client.extensions.setEnabled({ id: "intentic.automations", enabled: false }))).toBe("BAD_REQUEST");
    // Enabling an already-enabled essential is a no-op, not an error: idempotent callers stay simple.
    await client.extensions.setEnabled({ id: "intentic.automations", enabled: true });

    // The set is exactly the fail-active surfaces; a fail-safe one (drafts feeds only on prior approvals)
    // keeps its ordinary switch.
    const essentials = rows.filter((extension) => extension.essential === true).map((extension) => extension.id);
    expect(essentials.toSorted()).toEqual(["intentic.automations", "intentic.maintenance", "intentic.workflows"]);
});

test("re-enabling a premium extension re-checks the membership and refuses without one", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-premium-")));
    // The baked discord extension wearing a premium capability entry: what a git-installed premium extension
    // looks like to the enable route. The harness config has no platform, so the fresh probe answers no,
    // which is the fail-closed path: no reachable platform, no premium enable.
    const svc = services({
        workspace,
        capabilities: memoryCapabilitiesStore([
            { id: "intentic.discord", kind: "extension", config: { url: "https://github.com/acme/x.git", ref: "a".repeat(40), tier: "premium" } },
        ]),
    });
    const client = clientFor(createApp(svc));

    await client.extensions.setEnabled({ id: "intentic.discord", enabled: false });
    expect(await errorCode(client.extensions.setEnabled({ id: "intentic.discord", enabled: true }))).toBe("FORBIDDEN");
    // Switching OFF is never gated: a lapsed member can always stop things.
    await client.extensions.setEnabled({ id: "intentic.discord", enabled: false });
});

test("a service run on a platform-less sandbox refuses with the reason, charging nothing", async () => {
    // The harness config has no platform URL: the relay's one local answer. Everything else about a run
    // (member gate, meter, refunds) is the platform's and tested there; what the daemon owes is an honest
    // sentence instead of a hang.
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-service-")));
    const svc = services({ workspace });
    const app = createApp(svc);
    const response = await app.request("/pool/services/acme-research/run", {
        method: "POST",
        body: `{"query":"x"}`,
        headers: { "content-type": "application/json", authorization: "Bearer test-owner" },
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("not connected to a platform");
});

test("a workspace extension lists like any other and serves its bundle by content hash", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-workspace-")));
    const dir = join(workspaceExtensionsRoot(workspace.root), "hello");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "acme", name: "hello", version: "1.0.0", engines: { intentic: "^0.2.0" }, entry: "dist/index.js" }),
    );
    await writeFile(join(dir, "dist", "index.js"), "export const activate = () => {};");
    // A sibling directory that is not an extension rides the same list as a named failure: the author's
    // feedback channel, since nothing install-shaped ever rejected it.
    await mkdir(join(workspaceExtensionsRoot(workspace.root), "scratch"), { recursive: true });

    const app = createApp(services({ workspace }));
    const list = await clientFor(app).extensions.list();
    expect(list.extensions.find((extension) => extension.id === "acme.hello")).toMatchObject({
        source: "workspace",
        commit: "workspace",
        enabled: true,
    });
    expect(list.invalid).toEqual([{ dir: "scratch", error: expect.stringContaining("no intentic-extension.json") }]);

    // The bundle's identity is its bytes: same bytes answer 304, edited bytes are a new ETag, the live-edit
    // loop a sha-pinned checkout never needs.
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
    // The Extensions tab is only a complete list if the daemon enumerates the web-builtin extensions too:
    // their manifests ride the image beside the daemon-side ones (Dockerfile), so a bake that drops one shows
    // up here rather than as a silently missing row.
    const client = clientFor(createApp(services({ workspace: workspacePaths(mkdtempSync(join(tmpdir(), "ext-list-"))) })));
    const ids = (await client.extensions.list()).extensions.map((extension) => extension.id).toSorted();
    expect(ids).toEqual([
        "intentic.acceptance",
        "intentic.acp-agents",
        "intentic.activity",
        "intentic.automations",
        "intentic.browsers",
        "intentic.computers",
        "intentic.connectors",
        "intentic.deployments",
        "intentic.discord",
        "intentic.documentation",
        "intentic.drafts",
        "intentic.git-history",
        "intentic.google-workspace",
        "intentic.imap",
        "intentic.knowledge",
        /* No `intentic.logs`, and its absence is the first instance of a deliberate pattern rather than a
         * regression. Logs moved OUT of this repo to its own (extensions/logs), because a screen that is not a
         * control surface for an engine the daemon runs regardless does not have to ship in every image: it is
         * installed by whoever wants it. The set that stays baked is the one a sandbox is not itself without:
         * automations, workflows and maintenance (each the only window onto something running anyway) and
         * viewers (without which every image, PDF and video in the workspace falls back to a download). */
        "intentic.maintenance",
        "intentic.memory",
        "intentic.pi-agent",
        "intentic.pipelines",
        "intentic.preview",
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
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-create-")));
    const app = createApp(services({ workspace }));
    const client = clientFor(app);

    const created = await client.extensions.create({ publisher: "workspace", name: "release-notes" });
    expect(created).toEqual({ id: "workspace.release-notes", dir: ".intentic/config/workspace-extensions/release-notes" });

    // It is a real row on the same list the tab renders, on by default, not a draft awaiting an install step.
    const listed = (await client.extensions.list()).extensions.find((extension) => extension.id === "workspace.release-notes");
    expect(listed).toMatchObject({ source: "workspace", enabled: true });
    expect(listed?.manifest.permissions).toBeUndefined();
    expect(listed?.manifest.engines.intentic).toBe(`^${extensionApiVersion}`);
    expect(listed?.manifest.contributes?.views).toEqual([{ id: "release-notes", label: "Release Notes", surface: "rail" }]);

    /* THE POINT OF THE SCAFFOLD: the bundle route serves the entry as written, so what was created is already
     * the thing that runs. A scaffold that emitted a vite project would answer 404 here until someone installed
     * and built it: listed, switched on, and dead. */
    const bundle = await app.request("/extensions/workspace.release-notes/bundle");
    expect(bundle.status).toBe(200);
    const source = await bundle.text();
    expect(source).toContain(`export const activate`);
    // Only bare specifiers the host's import map publishes, and no relative import: a blob-URL module cannot
    // resolve one, so a second file would 404 at activation.
    expect([...source.matchAll(/^import .* from "(.*)";$/gmu)].map((match) => match[1])).toEqual(["vue"]);
});

test("extensions.create refuses a name that is already taken, without touching what is there", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-create-clash-")));
    const client = clientFor(createApp(services({ workspace })));

    await client.extensions.create({ publisher: "workspace", name: "notes" });
    const entry = join(workspaceExtensionsRoot(workspace.root), "notes", "extension.js");
    await writeFile(entry, "export const activate = () => { /* edited */ };");

    expect(await errorCode(client.extensions.create({ publisher: "workspace", name: "notes" }))).toBe("CONFLICT");
    // The author's edit survived: creating over an existing directory would destroy work with no checkout to
    // recover it from, which is why the directory is created non-recursively.
    expect(await readFile(entry, "utf8")).toContain("edited");
});

test("usage is counted per declared route, accumulates across reports, and rides the list", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-usage-")));
    const client = clientFor(createApp(services({ workspace })));
    // A first-party extension with a real permissions list, so the manifest doing the filtering is a shipped one.
    const id = "intentic.repo-apps";
    const declared = (await client.extensions.list()).extensions.find((extension) => extension.id === id)?.manifest.permissions?.sandbox ?? [];
    expect(declared.length).toBeGreaterThan(1);
    const [first, second] = declared as [string, string];

    // Nothing observed yet: `usage` is ABSENT rather than empty, which is what lets the row tell "never
    // exercised" from "exercised and uses none of these": the difference between evidence and a guess.
    expect((await client.extensions.list()).extensions.find((extension) => extension.id === id)?.usage).toBeUndefined();

    await client.extensions.recordUsage({ id, used: { [first]: 2 } });
    await client.extensions.recordUsage({ id, used: { [first]: 3, [second]: 1 } });

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

    // A browser still running a previous manifest reports a route this one never declared. Dropped rather than
    // refused: it is not an error the owner can act on, and recording it would credit reach nobody approved.
    await client.extensions.recordUsage({ id, used: { [kept]: 1, "DELETE /everything": 9 } });

    const usage = (await client.extensions.list()).extensions.find((extension) => extension.id === id)?.usage;
    expect(usage?.[kept]?.calls).toBe(1);
    expect(usage?.["DELETE /everything"]).toBeUndefined();
});

test("readiness catches the two failures that are invisible here and fatal once published", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-readiness-")));
    const client = clientFor(createApp(services({ workspace })));

    // A scaffolded extension is publishable on every check that can be answered from its files.
    await client.extensions.create({ publisher: "workspace", name: "clean" });
    const clean = await client.extensions.readiness({ id: "workspace.clean" });
    expect(clean.checks.filter((check) => check.status === "fail")).toEqual([]);
    // Its permissions check passes on the strongest possible ground: the scaffold declares no daemon reach at
    // all, so there is nothing to have earned. (The `warn` state is for an extension that DOES declare routes and
    // has never been exercised: the case where this check has nothing to say and must not say "fine".)
    expect(clean.checks.find((check) => check.id === "permissions")).toMatchObject({
        status: "pass",
        detail: "It asks for no daemon routes at all.",
    });

    /* Now the two ways a bundle that works here dies elsewhere. Both are silent in this workspace: the daemon
     * serves the entry live and the author never sees a failure, and both are fatal at activation for anyone
     * who installs the published sha. */
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
    // A relative import cannot resolve against the blob URL the bundle is imported from: reported before the
    // second import is even considered, because it is the one that 404s.
    expect(failed["bundle"]?.status).toBe("fail");
    expect(failed["bundle"]?.detail).toContain("./helper.js");
    // And the engines range excludes the app it would be published from, so no installer could activate it.
    expect(failed["engines"]?.status).toBe("fail");
    expect(failed["engines"]?.detail).toContain("^1.0.0");
});

test("readiness reports a promised file that is not there", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-readiness-paths-")));
    const client = clientFor(createApp(services({ workspace })));
    const dir = join(workspaceExtensionsRoot(workspace.root), "promises");
    await mkdir(dir, { recursive: true });
    // A manifest promising a CLI directory that was never committed: nothing fails here, and the agent's PATH
    // quietly lacks the tool on somebody else's machine.
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "workspace", name: "promises", version: "0.1.0", engines: { intentic: "^2.0.0" }, contributes: { bin: "bin" } }),
    );

    const checks = await client.extensions.readiness({ id: "workspace.promises" });
    const paths = checks.checks.find((check) => check.id === "paths");
    expect(paths?.status).toBe("fail");
    expect(paths?.detail).toContain("bin directory (bin)");
});
