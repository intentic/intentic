import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionEvent, ExtensionEventSchema } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { Hono } from "hono";
import type { ExtensionGrant } from "../../auth/grants.js";
import { memorySecretVault } from "../../capabilities/capabilities-slice.testing.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../testing.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { announceUnwatchedWrite } from "../../workspace/watch/workspace-watch.js";
import { writeExtensionSettings } from "../extension-settings.js";
import { createExtensionOwnRoutes } from "./own.routes.js";

// The two routes an extension's own code asks about itself, over the shipped _extensions tree (testConfig): each answers
// only the extension whose token is presented, and only about that extension.

const GRANTS = new Map<string, ExtensionGrant>([
    ["onlyoffice-token", { id: "intentic.onlyoffice", permissions: [] }],
    ["stranger-token", { id: "acme.not-installed", permissions: [] }],
]);

const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "extension-own-"));
    const vault = memorySecretVault();
    const services = unstubbed<Services>("services", {
        config: testConfig,
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        extensionSecretVault: vault,
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", { verifyExtensionToken: (presented) => GRANTS.get(presented) }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });
    const routes = createExtensionOwnRoutes(services);
    const app = new Hono().get("/extension/settings", routes.settings).get("/extension/events", routes.events);
    return { root, vault, app };
};

const as = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { [EXTENSION_TOKEN_HEADER]: token } });

test("an extension reads its own settings, secrets included, and nobody else's token gets them", async () => {
    const { root, vault, app } = setup();
    await writeExtensionSettings(root, vault, "intentic.onlyoffice", { engine: "server", token: "s3cret" }, new Set(["token"]));

    const own = await app.request("/extension/settings", as("onlyoffice-token"));
    expect(await own.json()).toEqual({ settings: { engine: "server", token: "s3cret" } });
    expect((await app.request("/extension/settings")).status).toBe(403);
    expect((await app.request("/extension/settings", as("stranger-token"))).status).toBe(404);
});

test("its event stream carries a heartbeat, its own settings' changed keys and unnamed workspace writes", async () => {
    const { root, vault, app } = setup();
    await writeExtensionSettings(root, vault, "intentic.onlyoffice", { engine: "browser" }, new Set());
    const controller = new AbortController();
    const response = await app.request("/extension/events", as("onlyoffice-token", { signal: controller.signal }));
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames: ExtensionEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pump = (async () => {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            frames.push(...lines.filter((line) => line !== "").map((line) => ExtensionEventSchema.parse(JSON.parse(line))));
        }
    })();
    await waitFor(() => expect(frames).toContainEqual({ kind: "heartbeat" }));

    // Another extension's write tells this one nothing; its own names exactly the key that moved.
    await writeExtensionSettings(root, vault, "acme.other", { engine: "server" }, new Set());
    await writeExtensionSettings(root, vault, "intentic.onlyoffice", { engine: "server" }, new Set());
    announceUnwatchedWrite();
    await waitFor(() => {
        expect(frames).toContainEqual({ kind: "settings", keys: ["engine"] });
        expect(frames).toContainEqual({ kind: "files", paths: [] });
    });
    expect(frames.filter((frame) => frame.kind === "settings")).toHaveLength(1);

    controller.abort();
    await reader.cancel().catch(() => undefined);
    await pump.catch(() => undefined);
});
