import { mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../app.js";

import { listenerProvidersOf } from "./installed-extensions.js";

import { workspacePaths } from "../workspace/workspace.js";

import { clientFor, errorCode, services } from "../route-testing.js";

/* The extensions routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("extensions.setEnabled keeps the extension listed, switches it off, and unwires it daemon-side", async () => {
    // A real workspace root, because the switch persists to <root>/.intentic/extension-enablement.json. The
    // extensions dir is the repo's own _extensions, so this runs against the shipped first-party manifests.
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-toggle-")));
    const svc = services({ workspace });
    const client = clientFor(createApp(svc));

    const listed = async (): Promise<Record<string, boolean>> =>
        Object.fromEntries((await client.extensions.list()).extensions.map((extension) => [extension.id, extension.enabled]));

    expect((await listed())["intentic.discord"]).toBe(true);
    expect((await listenerProvidersOf(svc)).get("discord")).toEqual(new Set(["message", "voice_utterance", "voice_transcript"]));

    await client.extensions.setEnabled({ id: "intentic.discord", enabled: false });

    // Still listed — that is what keeps the switch reachable — and off.
    expect((await listed())["intentic.discord"]).toBe(false);
    // The listener provider an automations trigger validates against is gone with it, and its declared gateway
    // can no longer be started by hand.
    expect((await listenerProvidersOf(svc)).has("discord")).toBe(false);
    expect(await errorCode(client.extensions.processStart({ id: "intentic.discord", name: "gateway" }))).toBe("PRECONDITION_FAILED");

    // And back on, from the same list the tab renders.
    await client.extensions.setEnabled({ id: "intentic.discord", enabled: true });
    expect((await listed())["intentic.discord"]).toBe(true);
});

test("the extension list carries every first-party extension, compiled-in UI ones included", async () => {
    // The Extensions tab is only a complete list if the daemon enumerates the web-builtin extensions too —
    // their manifests ride the image beside the daemon-side ones (Dockerfile), so a bake that drops one shows
    // up here rather than as a silently missing row.
    const client = clientFor(createApp(services({ workspace: workspacePaths(mkdtempSync(join(tmpdir(), "ext-list-"))) })));
    const ids = (await client.extensions.list()).extensions.map((extension) => extension.id).toSorted();
    expect(ids).toEqual([
        "intentic.acceptance",
        "intentic.acp-agents",
        "intentic.activity",
        "intentic.automations",
        "intentic.computers",
        "intentic.connectors",
        "intentic.deployments",
        "intentic.discord",
        "intentic.documentation",
        "intentic.git-history",
        "intentic.imap",
        "intentic.logs",
        "intentic.maintenance",
        "intentic.memory",
        "intentic.pipelines",
        "intentic.preview",
        "intentic.repo-apps",
        "intentic.slack",
        "intentic.social",
        "intentic.viewers",
        "intentic.workflows",
    ]);
});
