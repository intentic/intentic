import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import { unstubbed } from "@intentic/testing";
import { workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import { approveExtension, extensionApprovals } from "../capabilities/extension-inventory/extension-approvals.js";
import type { Services } from "../composition.js";
import { testConfig } from "../env.config.testing.js";
import { recordingTurnStores, services } from "../harness/route-services.testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { approveLandedExtensions } from "./landed-extensions.js";

// A land is the owner's yes to the workspace extensions it carried: over a real repository standing in for the workspace,
// a land from `from` to `tip` turns on what its delta brought, and nothing it did not.

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]);
const commit = async (dir: string): Promise<string> => {
    await git(dir, "add", "-A");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "--allow-empty", "-m", "work");
    return (await git(dir, "rev-parse", "HEAD")).stdout.trim();
};

const MANIFEST = { publisher: "acme", name: "toolbox", version: "1.0.0", engines: { intentic: "^0.2.0" }, permissions: { sandbox: ["GET /panels"] } };
// The same extension asking for one more route: a power it was not approved for.
const WIDER = { ...MANIFEST, version: "1.1.0", permissions: { sandbox: ["GET /panels", "POST /panels/*/start"] } };
const OTHER = { ...MANIFEST, name: "other" };

const writeExtension = async (root: string, folder: string, manifest: object): Promise<void> => {
    const dir = join(workspaceExtensionsRoot(root), folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
};

const approvedFor = async (historyRoot: string, manifest: { readonly name: string }): Promise<boolean> =>
    (await extensionApprovals(historyRoot))(`acme.${manifest.name}`, ExtensionManifestSchema.parse(manifest)).approved;

// A workspace whose root repository `before` and `land` committed one after the other (from, tip), as the land left it in
// the workspace, and the services its `agent.landed` event reaches.
const landing = async (land: (root: string) => Promise<void>, before: (root: string) => Promise<void> = async () => {}) => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "landed-ext-")));
    const historyRoot = mkdtempSync(join(tmpdir(), "landed-ext-history-"));
    const root = workspace.root;
    await git(root, "init", "-q");
    await before(root);
    const from = await commit(root);
    await land(root);
    const tip = await commit(root);
    const { writes, overrides } = recordingTurnStores();
    // SAFETY: only `placement` is read of the record: where the land left the root repository.
    const entry = { placement: { kind: "worktree", repos: [{ repo: "root", base: from, landedTip: tip }] } } as never;
    const svc = services({
        ...overrides,
        workspace,
        config: { ...testConfig, historyRoot },
        agents: unstubbed<Services["agents"]>("agents", { entry: () => entry }),
    });
    const event: WorkspaceEvent = {
        event: "agent.landed",
        agentId: "conv-1",
        title: "Add a toolbox",
        branch: "agent/conv-1",
        outcome: "landed",
        repos: [{ repo: "root", from, dir: root }],
    };
    return { svc, event, writes, historyRoot, root };
};

test("a land that carries a new workspace extension turns it on and says so on the conversation's Activity", async () => {
    const { svc, event, writes, historyRoot } = await landing((root) => writeExtension(root, "toolbox", MANIFEST));

    const carried = await approveLandedExtensions(svc, event);

    expect(carried.map((extension) => extension.id)).toEqual(["acme.toolbox"]);
    expect(await approvedFor(historyRoot, MANIFEST)).toBe(true);
    expect(writes.activity).toEqual([
        expect.objectContaining({
            direction: "system",
            type: "extension.landed_on",
            conversationId: "conv-1",
            content: expect.stringMatching(/^Landing "Add a toolbox" turned on the extension acme\.toolbox, which can: .+\.$/),
        }),
    ]);
});

test("an extension waiting in the workspace that the land did not touch keeps waiting", async () => {
    const { svc, event, historyRoot, root } = await landing((at) => writeExtension(at, "toolbox", MANIFEST));
    // Written straight into the workspace, beside the land: no delta of it.
    await writeExtension(root, "other", OTHER);

    await approveLandedExtensions(svc, event);

    expect(await approvedFor(historyRoot, MANIFEST)).toBe(true);
    expect(await approvedFor(historyRoot, OTHER)).toBe(false);
});

test("an extension edited in the workspace to ask for more since the land waits for the Approve press", async () => {
    const { svc, event, writes, historyRoot, root } = await landing((at) => writeExtension(at, "toolbox", MANIFEST));
    await writeExtension(root, "toolbox", WIDER);

    expect(await approveLandedExtensions(svc, event)).toEqual([]);
    expect(await approvedFor(historyRoot, WIDER)).toBe(false);
    expect(await approvedFor(historyRoot, MANIFEST)).toBe(false);
    expect(writes.activity).toEqual([]);
});

test("a land that gives an approved extension a new power approves it again, naming only what it gained", async () => {
    const { svc, event, writes, historyRoot } = await landing(
        (root) => writeExtension(root, "toolbox", WIDER),
        (root) => writeExtension(root, "toolbox", MANIFEST),
    );
    await approveExtension(historyRoot, "acme.toolbox", ExtensionManifestSchema.parse(MANIFEST));
    expect(await approvedFor(historyRoot, WIDER)).toBe(false);

    await approveLandedExtensions(svc, event);

    expect(await approvedFor(historyRoot, WIDER)).toBe(true);
    const [row] = writes.activity;
    expect(row?.content).toContain("POST /panels/*/start");
    expect(row?.content).not.toContain("GET /panels;");
});

test("work held on its branch, or a land that left the root repository where it was, turns nothing on", async () => {
    const { svc, event, historyRoot } = await landing((root) => writeExtension(root, "toolbox", MANIFEST));

    expect(await approveLandedExtensions(svc, { ...event, outcome: "ready" })).toEqual([]);
    expect(await approveLandedExtensions(svc, { ...event, repos: [] })).toEqual([]);
    expect(await approvedFor(historyRoot, MANIFEST)).toBe(false);
});
