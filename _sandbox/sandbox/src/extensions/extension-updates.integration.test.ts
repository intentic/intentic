import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitCheckout, gitClone, gitFullHead, gitHead } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { extensionDir, extensionsRoot } from "../capabilities/extension-dirs.js";
import { previousDir } from "../capabilities/git-checkout.js";
import { clientFor } from "../harness/route-client.testing.js";
import { fakeFiles } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";
import { makeWorkspaceDir, moveWorkspacePath, readWorkspaceFile, removeWorkspacePath } from "../workspace/files/workspace-files.js";
import { workspacePaths } from "../workspace/workspace.js";
import { readExtensionEnablement } from "./extension-enablement.js";
import { checkExtensionUpdates, readExtensionUpdateState, writeUpdatePolicy } from "./extension-updates.js";

// Update lifecycle end-to-end (discover, preview, apply, revert), driven over the daemon's HTTP surface, browser-style.
// Against real git fixtures standing in for the author's repo and the registry.

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]);
const commit = async (dir: string): Promise<string> => {
    await git(dir, "add", "-A");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t.dev", "commit", "-q", "-m", "release");
    return (await git(dir, "rev-parse", "HEAD")).stdout.trim();
};

const MANIFEST_V1 = {
    publisher: "acme",
    name: "demo",
    version: "1.0.0",
    engines: { intentic: "^2" },
    entry: "dist/extension.js",
    permissions: { sandbox: ["GET /panels"] },
};
// Grows the manifest by one declared route; that's the powers diff's whole subject.
const MANIFEST_V2 = { ...MANIFEST_V1, version: "1.1.0", permissions: { sandbox: ["GET /panels", "POST /panels/*/start"] } };

const authorRepo = async (): Promise<{ url: string; v1: string; v2: string }> => {
    const dir = mkdtempSync(join(tmpdir(), "ext-author-"));
    await git(dir, "init", "-q");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "extension.js"), "export default { activate() {} };");
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(MANIFEST_V1));
    const v1 = await commit(dir);
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(MANIFEST_V2));
    const v2 = await commit(dir);
    return { url: dir, v1, v2 };
};

// Registry repo with one row pointing at the author's repo; `entry` overrides let a test bless or block the listing.
const registryRepo = async (author: { url: string }, sha: string, entry: object = {}): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "ext-registry-"));
    await git(dir, "init", "-q");
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
        join(dir, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
            name: "test-registry",
            plugins: [{ name: "acme.demo", kind: "extension", version: "1.1.0", source: { source: "url", url: author.url, sha }, ...entry }],
        }),
    );
    await commit(dir);
    return dir;
};

// Workspace with v1 installed the way the capability handler leaves it: a checkout pinned at the sha.
const installedWorkspace = async (author: { url: string; v1: string }, registry: string) => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-updates-")));
    await mkdir(extensionsRoot(workspace.root), { recursive: true });
    await exec("git", ["clone", "-q", author.url, extensionDir(workspace.root, "demo")]);
    await git(extensionDir(workspace.root, "demo"), "checkout", "--detach", "-q", author.v1);
    const svc = services({
        workspace,
        capabilities: memoryCapabilitiesStore([{ id: "demo", kind: "extension", config: { url: author.url, ref: author.v1, registry } }]),
        // Real git/files verbs, not stubs: this suite is about clones, swaps and heads against the fixtures above.
        git: { clone: gitClone, checkout: gitCheckout, head: gitHead, fullHead: gitFullHead },
        files: fakeFiles({ read: readWorkspaceFile, mkdir: makeWorkspaceDir, remove: removeWorkspacePath, move: moveWorkspacePath }),
    });
    return { workspace, svc, client: clientFor(createApp(svc)) };
};

const installedVersion = async (root: string): Promise<string> =>
    (JSON.parse(await readFile(join(extensionDir(root, "demo"), "intentic-extension.json"), "utf8")) as { version: string }).version;

test("discover → preview → apply → revert: the whole update lifecycle over the wire", async () => {
    const author = await authorRepo();
    const registry = await registryRepo(author, author.v2, { securityFix: true });
    const { workspace, svc, client } = await installedWorkspace(author, registry);

    await checkExtensionUpdates(svc);
    const state = await readExtensionUpdateState(workspace.root);
    expect(state.extensions["acme.demo"]?.update).toMatchObject({ ref: author.v2, version: "1.1.0", trust: "listed", securityFix: true });

    const listed = await client.extensions.list();
    const row = listed.extensions.find((extension) => extension.id === "demo");
    expect(row?.update?.ref).toBe(author.v2);
    expect(row?.updatePolicy).toEqual({ updates: "notify", advisories: "auto-disable" });
    expect(listed.updatesCheckedAt).toEqual(expect.any(String));

    const preview = await client.extensions.updatePreview({ id: "demo" });
    expect(preview).toMatchObject({ ref: author.v2, version: "1.1.0", installedVersion: "1.0.0", compatible: true });
    expect(preview.powers.added).toEqual(["its UI calls the sandbox route POST /panels/*/start"]);
    expect(preview.powers.removed).toEqual([]);

    const applied = await client.extensions.applyUpdate({ id: "demo" });
    expect(applied.ref).toBe(author.v2);
    expect(await installedVersion(workspace.root)).toBe("1.1.0");
    expect((await svc.capabilities.get("demo"))?.config).toMatchObject({ ref: author.v2 });
    const kept = JSON.parse(await readFile(join(previousDir(extensionsRoot(workspace.root), "demo"), "intentic-extension.json"), "utf8")) as {
        version: string;
    };
    expect(kept.version).toBe("1.0.0");
    const afterApply = await readExtensionUpdateState(workspace.root);
    expect(afterApply.extensions["acme.demo"]?.update).toBeUndefined();
    expect(afterApply.extensions["acme.demo"]?.health?.state).toBe("watching");

    const reverted = await client.extensions.revert({ id: "demo" });
    expect(reverted.ref).toBe(author.v1);
    expect(await installedVersion(workspace.root)).toBe("1.0.0");
    expect((await svc.capabilities.get("demo"))?.config).toMatchObject({ ref: author.v1 });
});

test("a blocked listing raises an advisory and pulls the switch: the fail-safe direction", async () => {
    const author = await authorRepo();
    const registry = await registryRepo(author, author.v2, { trust: "blocked", trustReason: "exfiltrates the panel token" });
    const { workspace, svc, client } = await installedWorkspace(author, registry);

    await checkExtensionUpdates(svc);

    const state = await readExtensionUpdateState(workspace.root);
    expect(state.extensions["acme.demo"]?.advisory).toMatchObject({ reason: "exfiltrates the panel token", autoDisabled: true });
    expect((await readExtensionEnablement(workspace.root))["acme.demo"]).toBe(false);
    const row = (await client.extensions.list()).extensions.find((extension) => extension.id === "demo");
    expect(row?.enabled).toBe(false);
    expect(row?.advisory?.reason).toContain("exfiltrates");
    expect(row?.update).toBeUndefined();
});

test("the auto rung refuses an unverified listing and says so: the click stays the owner's", async () => {
    const author = await authorRepo();
    const registry = await registryRepo(author, author.v2);
    const { workspace, svc } = await installedWorkspace(author, registry);
    await writeUpdatePolicy(workspace.root, "acme.demo", { updates: "auto" });

    await checkExtensionUpdates(svc);

    expect(await installedVersion(workspace.root)).toBe("1.0.0");
    const state = await readExtensionUpdateState(workspace.root);
    expect(state.extensions["acme.demo"]?.update?.needsReview).toContain("isn't verified");
});

test("a verified release whose powers grew still falls back to notify, naming the new power", async () => {
    const author = await authorRepo();
    const registry = await registryRepo(author, author.v2, {
        trust: "verified",
        trustReason: "read at this sha",
        securityReview: {
            sha: author.v2,
            url: author.url,
            policy: "team-policy",
            reviewer: "team-reviewer",
            reviewedAt: "2026-08-01T00:00:00.000Z",
            runId: "run-1",
            deterministic: { policy: "team-scan", scanner: "scanner", version: "1", runId: "scan-1" },
        },
    });
    const { workspace, svc } = await installedWorkspace(author, registry);
    await writeUpdatePolicy(workspace.root, "acme.demo", { updates: "auto" });

    await checkExtensionUpdates(svc);

    expect(await installedVersion(workspace.root)).toBe("1.0.0");
    const state = await readExtensionUpdateState(workspace.root);
    expect(state.extensions["acme.demo"]?.update?.needsReview).toContain("POST /panels/*/start");
});

test("an unreachable registry keeps the previous records: offline never reads as all-clear", async () => {
    const author = await authorRepo();
    const registry = await registryRepo(author, author.v2);
    const { workspace, svc } = await installedWorkspace(author, registry);

    await checkExtensionUpdates(svc);
    expect((await readExtensionUpdateState(workspace.root)).extensions["acme.demo"]?.update?.ref).toBe(author.v2);

    // Simulates the registry vanishing (deleted, or the network down); both read the same way.
    await exec("rm", ["-rf", registry]);
    await checkExtensionUpdates(svc);
    expect((await readExtensionUpdateState(workspace.root)).extensions["acme.demo"]?.update?.ref).toBe(author.v2);
});
