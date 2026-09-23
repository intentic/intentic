import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import { gateSettingsHooks } from "../guard/hook-approvals.js";
import { clientFor, proven } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";

// The two approvals an agent must never give itself, over the daemon's HTTP surface with auth on: a workspace hook set
// and a workspace extension. Every credential a program in the sandbox can hold is refused; the owner's session is not.

const OWNER = "owner-session";

// A daemon with auth on, a hook set a turn found and a workspace extension nobody approved.
const sandbox = async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "owner-approvals-")));
    const historyRoot = mkdtempSync(join(tmpdir(), "owner-approvals-history-"));
    await mkdir(join(workspace.root, ".claude"), { recursive: true });
    await writeFile(
        join(workspace.root, ".claude", "settings.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );
    const place = {
        cwd: workspace.root,
        home: join(historyRoot, "home"),
        configDir: join(historyRoot, "home", ".claude"),
        readable: (path: string) => path,
    };
    const digest = (await gateSettingsHooks(historyRoot, place, undefined)).set?.digest ?? "";
    const dir = join(workspaceExtensionsRoot(workspace.root), "stranger");
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "acme", name: "stranger", version: "1.0.0", engines: { intentic: "^2.0.0" } }),
    );
    const app = createApp(
        services({
            workspace,
            config: { ...testConfig, historyRoot },
            auth: {
                authorize: async (bearer) => {
                    if (bearer !== OWNER) {
                        throw new Error("no bearer");
                    }
                    return proven("owner@example.com", "owner");
                },
            },
        }),
    );
    const extensionDigest = (await clientFor(app, { bearer: OWNER }).extensions.list()).pending[0]?.digest ?? "";
    return { app, digest, extensionDigest };
};

const post = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>, body?: object): Promise<Response> =>
    Promise.resolve(
        app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) }),
    );

test("no token a program holds approves a hook set or a workspace extension; the owner's session does", async () => {
    const { app, digest, extensionDigest } = await sandbox();
    const hooks = `/approvals/hooks/${digest}/approve`;
    const extension = `/extensions/acme.stranger/approve`;
    // Out of the panel's and the agent's reach by declaration (403), and nobody at all without a session (401).
    const machines: readonly [Record<string, string>, number][] = [
        [{ "x-intentic-panel": "panel-secret" }, 403],
        [{ "x-intentic-agent": "agent-secret" }, 403],
        [{}, 401],
    ];

    for (const [headers, refused] of machines) {
        expect([headers, (await post(app, hooks, headers)).status]).toEqual([headers, refused]);
        expect([headers, (await post(app, extension, headers, { digest: extensionDigest })).status]).toEqual([headers, refused]);
    }

    const owner = { authorization: `Bearer ${OWNER}` };
    expect((await post(app, hooks, owner)).status).toBe(200);
    expect((await post(app, extension, owner, { digest: extensionDigest })).status).toBe(200);
    const listed = await clientFor(app, { bearer: OWNER }).extensions.list();
    expect(listed.pending).toEqual([]);
    expect(listed.extensions.some((entry) => entry.id === "acme.stranger")).toBe(true);
});
