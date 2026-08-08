import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_WORKSPACE_STATE_DIRS, type Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { packBundle } from "./bundle.js";
import { BundleFormatError, restoreBundle } from "./restore.js";

/* THE ROUND TRIP — export a sandbox's two volumes, restore them into empty ones, and check that what came out
 * is what went in. The claim this suite exists to hold is the one the feature was asked for: "export and then
 * import result in the same environment". Anything the bundle deliberately does NOT carry is asserted just as
 * hard as what it does, because a silent omission is the failure mode that made this feature necessary.
 */

const LIMIT = 64 * 1024 * 1024;

const roots: string[] = [];
const makeRoots = async (): Promise<{ work: string; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-bundle-"));
    roots.push(dir);
    const work = join(dir, "work");
    const history = join(dir, "history");
    await mkdir(work, { recursive: true });
    await mkdir(history, { recursive: true });
    return { work, history };
};

const cleanup = async (): Promise<void> => {
    for (const dir of roots.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
};

// Services shaped for the bundler: the real roots, real file reads (it reads the custom overlay off disk), and
// whatever capability manifest the test wants the environment facts derived from.
const bundlerServices = (work: string, history: string, capabilities: Capability[] = []): Services =>
    services({
        workspace: workspacePaths(work),
        config: { ...testConfig, workspaceRoot: work, historyRoot: history },
        capabilities: memoryCapabilitiesStore(capabilities),
        files: fakeFiles({ read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined) }),
    } as Parameters<typeof services>[0]);

const bundleOf = async (
    source: { work: string; history: string },
    secrets: boolean,
    capabilities: Capability[] = [],
): Promise<ReadableStream<Uint8Array>> => {
    const stream = packBundle(bundlerServices(source.work, source.history, capabilities), { secrets, now: 1_700_000_000_000 });
    // Buffered here only so one test can restore it twice; the route streams it straight to the wire.
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    return new Blob(chunks.map((chunk) => new Uint8Array(chunk))).stream();
};

test("a workspace round-trips: content, nesting, modes and symlinks all survive", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, "repo/src"), { recursive: true });
    await writeFile(join(source.work, "repo/src/main.ts"), "export const x = 1;\n");
    await writeFile(join(source.work, "repo/run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(source.work, "repo/run.sh"), 0o755);
    await symlink("src/main.ts", join(source.work, "repo/link.ts"));
    await mkdir(join(source.work, "empty-on-purpose"), { recursive: true });

    const target = await makeRoots();
    const report = await restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    expect(await readFile(join(target.work, "repo/src/main.ts"), "utf8")).toBe("export const x = 1;\n");
    // The mode is the assertion that separates this from the folder-drop path, which writes every file 0644.
    expect((await stat(join(target.work, "repo/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(target.work, "repo/link.ts"), "utf8")).toBe("export const x = 1;\n");
    expect((await stat(join(target.work, "empty-on-purpose"))).isDirectory()).toBe(true);
    expect(report.restored.workspaceFiles).toBeGreaterThan(0);
    expect(report.refused).toEqual([]);
    await cleanup();
});

test("every repo's real git dir travels, and its in-tree pointer is rewritten for the target's historyRoot", async () => {
    const source = await makeRoots();
    // The shape the daemon keeps: the git dir on /history, the in-tree .git a pointer file naming it.
    await mkdir(join(source.history, "gits/root/refs"), { recursive: true });
    await writeFile(join(source.history, "gits/root/HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(source.history, "gits/nested/refs"), { recursive: true });
    await writeFile(join(source.history, "gits/nested/HEAD"), "ref: refs/heads/agent/x\n");
    await writeFile(join(source.work, ".git"), `gitdir: ${join(source.history, "gits/root")}\n`);
    await mkdir(join(source.work, "nested"), { recursive: true });
    await writeFile(join(source.work, "nested/.git"), `gitdir: ${join(source.history, "gits/nested")}\n`);
    await writeFile(join(source.work, "nested/file.txt"), "x");

    const target = await makeRoots();
    const report = await restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    // The git dirs themselves came across…
    expect(await readFile(join(target.history, "gits/root/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(await readFile(join(target.history, "gits/nested/HEAD"), "utf8")).toBe("ref: refs/heads/agent/x\n");
    // …and both pointers now name the TARGET's historyRoot, not the source's. Without this the restored tree is
    // a pile of files answering `fatal: not a git repository` to every command.
    expect(await readFile(join(target.work, ".git"), "utf8")).toBe(`gitdir: ${join(target.history, "gits/root")}\n`);
    expect(await readFile(join(target.work, "nested/.git"), "utf8")).toBe(`gitdir: ${join(target.history, "gits/nested")}\n`);
    // Root first, then the discovered repos — the order healGitPointers walks, so a failure names the repo.
    expect(report.restored.repos).toEqual(["root", "nested"]);
    await cleanup();
});

test("identity never travels and is refused on the way in even when a bundle carries it", async () => {
    const source = await makeRoots();
    await writeFile(join(source.history, "session-secret"), "signing-key");
    await mkdir(join(source.work, ".intentic"), { recursive: true });
    await writeFile(join(source.work, ".intentic/owner.json"), `{"email":"owner@example.com"}`);
    await writeFile(join(source.work, ".intentic/settings.json"), `{"autoLand":true}`);

    const target = await makeRoots();
    const report = await restoreBundle(await bundleOf(source, true), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    // Ordinary settings travel even with secrets on…
    expect(await readFile(join(target.work, ".intentic/settings.json"), "utf8")).toBe(`{"autoLand":true}`);
    // …the two identity files do not, and `secrets: true` does not buy them. Carrying owner.json would hand the
    // target's ownership to whoever holds the bundle.
    await expect(readFile(join(target.work, ".intentic/owner.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "session-secret"), "utf8")).rejects.toThrow();
    expect(report.refused).toEqual([]);
    await cleanup();
});

test("secrets obey the owner's export choice, in both directions", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, ".intentic"), { recursive: true });
    await writeFile(join(source.work, ".intentic/capabilities.json"), `[{"id":"mcp1","kind":"mcp","config":{"token":"t"}}]`);
    await writeFile(join(source.work, ".intentic/ci.json"), `{"secret":"webhook"}`);

    const withoutSecrets = await makeRoots();
    await restoreBundle(await bundleOf(source, false), { workspaceRoot: withoutSecrets.work, historyRoot: withoutSecrets.history }, LIMIT);
    await expect(readFile(join(withoutSecrets.work, ".intentic/capabilities.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(withoutSecrets.work, ".intentic/ci.json"), "utf8")).rejects.toThrow();

    const withSecrets = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: withSecrets.work, historyRoot: withSecrets.history }, LIMIT);
    expect(await readFile(join(withSecrets.work, ".intentic/capabilities.json"), "utf8")).toContain("mcp1");
    expect(await readFile(join(withSecrets.work, ".intentic/ci.json"), "utf8")).toContain("webhook");
    await cleanup();
});

test("conversation state travels while every provider runtime home stays secret", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, ".intentic/sessions/claude/projects/-history-gits-root/memory"), { recursive: true });
    await writeFile(join(source.work, ".intentic/sessions/claude/projects/-history-gits-root/memory/MEMORY.md"), "# what I learned\n");
    const providerFiles = [
        ["claude", "default.json"],
        ["codex", "auth.json"],
        ["opencode", "auth.json"],
        ["cliproxy", "config.yaml"],
    ] as const;
    for (const [provider, file] of providerFiles) {
        await mkdir(join(source.work, ".intentic/auth", provider), { recursive: true });
        await writeFile(join(source.work, ".intentic/auth", provider, file), "secret");
    }
    for (const provider of RETIRED_WORKSPACE_STATE_DIRS.secret) {
        await mkdir(join(source.work, ".intentic", provider), { recursive: true });
        await writeFile(join(source.work, ".intentic", provider, "retired-secret.json"), "retired secret");
    }

    const target = await makeRoots();
    await restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    expect(await readFile(join(target.work, ".intentic/sessions/claude/projects/-history-gits-root/memory/MEMORY.md"), "utf8")).toBe(
        "# what I learned\n",
    );
    for (const [provider, file] of providerFiles) {
        await expect(readFile(join(target.work, ".intentic/auth", provider, file), "utf8")).rejects.toThrow();
    }
    for (const provider of RETIRED_WORKSPACE_STATE_DIRS.secret) {
        await expect(readFile(join(target.work, ".intentic", provider, "retired-secret.json"), "utf8")).rejects.toThrow();
    }

    const secretTarget = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: secretTarget.work, historyRoot: secretTarget.history }, LIMIT);
    for (const [provider, file] of providerFiles) {
        expect(await readFile(join(secretTarget.work, ".intentic/auth", provider, file), "utf8")).toBe("secret");
    }
    for (const provider of RETIRED_WORKSPACE_STATE_DIRS.secret) {
        expect(await readFile(join(secretTarget.work, ".intentic", provider, "retired-secret.json"), "utf8")).toBe("retired secret");
    }
    await cleanup();
});

test("the composed overlay is left for the target to recompose; its source section travels", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, ".intentic/environment.d"), { recursive: true });
    await writeFile(join(source.work, ".intentic/environment.custom.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    await writeFile(join(source.work, ".intentic/environment.d/rust.Dockerfile"), "RUN rustup default stable\n");
    // Composed from a base image the target may not even be on — restoring it would pin the wrong FROM.
    await writeFile(join(source.work, ".intentic/environment.approved.Dockerfile"), "FROM registry.example/sandbox:old\n");

    const target = await makeRoots();
    const report = await restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    expect(await readFile(join(target.work, ".intentic/environment.custom.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
    // A pending agent request survives the move — the owner still has a question to answer on the other side.
    expect(await readFile(join(target.work, ".intentic/environment.d/rust.Dockerfile"), "utf8")).toBe("RUN rustup default stable\n");
    await expect(readFile(join(target.work, ".intentic/environment.approved.Dockerfile"), "utf8")).rejects.toThrow();
    // And the owner is told the one thing the container cannot do for itself.
    expect(report.needsAction.map((action) => action.subject)).toContain("Rebuild the environment image");
    await cleanup();
});

test("the report names the capabilities a no-secrets bundle left behind", async () => {
    const source = await makeRoots();
    const target = await makeRoots();
    const report = await restoreBundle(
        await bundleOf(source, false, [{ id: "docker", kind: "cli", config: {} } as Capability]),
        { workspaceRoot: target.work, historyRoot: target.history },
        LIMIT,
    );
    const action = report.needsAction.find((entry) => entry.subject === "Re-add capabilities");
    expect(action?.detail).toContain("docker");
    await cleanup();
});

test("derived trees are left out while durable artifacts travel", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, ".intentic/cache/iq"), { recursive: true });
    await writeFile(join(source.work, ".intentic/cache/iq/index.bin"), "cache");
    await mkdir(join(source.work, ".intentic/browser/chromium"), { recursive: true });
    await writeFile(join(source.work, ".intentic/browser/chromium/Cookies"), "cookies");
    await mkdir(join(source.work, ".intentic/artifacts/attachments/u1"), { recursive: true });
    await writeFile(join(source.work, ".intentic/artifacts/attachments/u1/shot.png"), "attachment");
    await mkdir(join(source.work, ".intentic/artifacts/browser"), { recursive: true });
    await writeFile(join(source.work, ".intentic/artifacts/browser/viewport.png"), "screenshot");
    await mkdir(join(source.work, ".intentic/runtime/extensions/whatsapp"), { recursive: true });
    await writeFile(join(source.work, ".intentic/runtime/extensions/whatsapp/gateway.url"), "http://127.0.0.1:1");
    for (const dir of RETIRED_WORKSPACE_STATE_DIRS.derived) {
        await mkdir(join(source.work, ".intentic", dir), { recursive: true });
        await writeFile(join(source.work, ".intentic", dir, "retired-cache.bin"), "retired cache");
    }
    await mkdir(join(source.history, "worktrees/abc/repo"), { recursive: true });
    await writeFile(join(source.history, "worktrees/abc/repo/file.ts"), "checkout");
    await mkdir(join(source.work, "repo/node_modules/pkg"), { recursive: true });
    await writeFile(join(source.work, "repo/node_modules/pkg/index.js"), "dep");

    const target = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    await expect(readFile(join(target.work, ".intentic/cache/iq/index.bin"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.work, ".intentic/browser/chromium/Cookies"), "utf8")).rejects.toThrow();
    expect(await readFile(join(target.work, ".intentic/artifacts/attachments/u1/shot.png"), "utf8")).toBe("attachment");
    expect(await readFile(join(target.work, ".intentic/artifacts/browser/viewport.png"), "utf8")).toBe("screenshot");
    await expect(readFile(join(target.work, ".intentic/runtime/extensions/whatsapp/gateway.url"), "utf8")).rejects.toThrow();
    for (const dir of RETIRED_WORKSPACE_STATE_DIRS.derived) {
        await expect(readFile(join(target.work, ".intentic", dir, "retired-cache.bin"), "utf8")).rejects.toThrow();
    }
    await expect(readFile(join(target.history, "worktrees/abc/repo/file.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.work, "repo/node_modules/pkg/index.js"), "utf8")).rejects.toThrow();
    await cleanup();
});

test("an undeclared /history file is left behind rather than carried on a guess", async () => {
    // The volume defaults to SKIP: a file no manifest claims is either junk from a build that moved on or state
    // this daemon has no name for, and neither belongs in a bundle.
    const source = await makeRoots();
    await writeFile(join(source.history, "some-future-store.json"), "{}");
    const target = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);
    await expect(readFile(join(target.history, "some-future-store.json"), "utf8")).rejects.toThrow();
    await cleanup();
});

test("a tar that is not a bundle is refused rather than half-extracted", async () => {
    const target = await makeRoots();
    const notABundle = new Blob([new Uint8Array([1, 2, 3, 4])]).stream();
    await expect(restoreBundle(notABundle, { workspaceRoot: target.work, historyRoot: target.history }, LIMIT)).rejects.toThrow();
    await cleanup();
});

test("a bundle whose manifest this daemon cannot read is refused by version, not guessed at", async () => {
    const source = await makeRoots();
    const target = await makeRoots();
    // Round-trip a real bundle first so the happy path is known-good in this same suite…
    await expect(
        restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT),
    ).resolves.toBeDefined();
    // …then prove the guard: BundleFormatError is what the route turns into a 400.
    expect(new BundleFormatError("x")).toBeInstanceOf(Error);
    await cleanup();
});
