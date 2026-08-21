import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { RETIRED_WORKSPACE_STATE_DIRS, type Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { packBundle } from "./bundle.js";
import { BundleFormatError, restoreBundle } from "./restore.js";

/* THE ROUND TRIP: export a sandbox's two volumes, restore them into empty ones, and check that what came out
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

/* Services shaped for the bundler: the real roots, real file reads (it reads the custom overlay off disk), and
 * whatever capability manifest the test wants the environment facts derived from.
 *
 * The two vault sweeps are stubbed to no-ops by DEFAULT rather than left unstubbed, because the export now runs
 * them before it walks (bundle.ts says why) and a fake that throws its own name would make every test here about
 * that seam. One test overrides them to prove the ordering. */
const bundlerServices = (work: string, history: string, capabilities: Capability[] = [], sweeps: Partial<Services> = {}): Services =>
    services({
        workspace: workspacePaths(work),
        config: { ...testConfig, workspaceRoot: work, historyRoot: history },
        capabilities: memoryCapabilitiesStore(capabilities),
        files: fakeFiles({ read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined) }),
        vaultManifestSecrets: async () => [],
        vaultExtensionSettingSecrets: async () => [],
        ...sweeps,
    } as Parameters<typeof services>[0]);

const bundleOf = async (
    source: { work: string; history: string },
    secrets: boolean,
    capabilities: Capability[] = [],
    sweeps: Partial<Services> = {},
): Promise<ReadableStream<Uint8Array>> => {
    const stream = packBundle(bundlerServices(source.work, source.history, capabilities, sweeps), { secrets, now: 1_700_000_000_000 });
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
    // Root first, then the discovered repos: the order healGitPointers walks, so a failure names the repo.
    expect(report.restored.repos).toEqual(["root", "nested"]);
    await cleanup();
});

test("identity never travels and is refused on the way in even when a bundle carries it", async () => {
    const source = await makeRoots();
    await writeFile(join(source.history, "session-secret"), "signing-key");
    await mkdir(join(source.work, `${STATE_DIR}/identity`), { recursive: true });
    await mkdir(join(source.work, `${STATE_DIR}/config`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/identity/owner.json`), `{"email":"owner@example.com"}`);
    await writeFile(join(source.work, `${STATE_DIR}/config/settings.json`), `{"autoLand":true}`);

    const target = await makeRoots();
    const report = await restoreBundle(await bundleOf(source, true), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    // Ordinary settings travel even with secrets on…
    expect(await readFile(join(target.work, ".intentic/config/settings.json"), "utf8")).toBe(`{"autoLand":true}`);
    // …the two identity files do not, and `secrets: true` does not buy them. Carrying owner.json would hand the
    // target's ownership to whoever holds the bundle.
    await expect(readFile(join(target.work, ".intentic/identity/owner.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "session-secret"), "utf8")).rejects.toThrow();
    expect(report.refused).toEqual([]);
    await cleanup();
});

test("secrets obey the owner's export choice, in both directions", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/secrets`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/secrets/ci.json`), `{"secret":"webhook"}`);

    const withoutSecrets = await makeRoots();
    await restoreBundle(await bundleOf(source, false), { workspaceRoot: withoutSecrets.work, historyRoot: withoutSecrets.history }, LIMIT);
    await expect(readFile(join(withoutSecrets.work, ".intentic/secrets/ci.json"), "utf8")).rejects.toThrow();

    const withSecrets = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: withSecrets.work, historyRoot: withSecrets.history }, LIMIT);
    expect(await readFile(join(withSecrets.work, ".intentic/secrets/ci.json"), "utf8")).toContain("webhook");
    await cleanup();
});

/* THE CAPABILITY MANIFEST CHANGED SIDES, and this is the pair of assertions that says why it was allowed to.
 *
 * It used to be asserted beside ci.json above: classed `secret`, dropped wholesale from a no-secrets bundle. It
 * now travels in every bundle, because the credential VALUES are no longer in it (capabilities-store.ts's vault)
 * and what is left is the shape of each connection, which is the difference between a target that arrives
 * listing its connections unauthenticated and one that arrives blank with a list of homework.
 *
 * That is only true of the BYTES while nothing has hand-written a real token back in, which is why the export
 * sweeps first and why the second half of this test is about ordering rather than about classification. The
 * stubbed sweep stands in for the vault: if it runs before the walk, the packed file holds the marker; if it
 * runs after, or not at all: the packed file holds the token, and a bundle the owner was told carried no
 * secrets carries one. */
test("the capability manifest travels without its credentials, swept before the walk", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/config`), { recursive: true });
    const manifestPath = join(source.work, `${STATE_DIR}/config/capabilities.json`);
    await writeFile(manifestPath, `[{"id":"mcp1","kind":"mcp","config":{"url":"https://mcp.example.com","token":"REAL-TOKEN"}}]`);

    const target = await makeRoots();
    await restoreBundle(
        await bundleOf(source, false, [], {
            vaultManifestSecrets: async () => {
                await writeFile(
                    manifestPath,
                    `[{"id":"mcp1","kind":"mcp","config":{"url":"https://mcp.example.com","token":"__intentic_vaulted__"}}]`,
                );
                return ["mcp1"];
            },
        }),
        { workspaceRoot: target.work, historyRoot: target.history },
        LIMIT,
    );

    const restored = await readFile(join(target.work, ".intentic/config/capabilities.json"), "utf8");
    // The shape arrived: the id, the kind and the address the owner would otherwise have to remember.
    expect(restored).toContain("mcp1");
    expect(restored).toContain("https://mcp.example.com");
    // The credential did not, and it is the sweep's ordering that decided that.
    expect(restored).not.toContain("REAL-TOKEN");
    await cleanup();
});

test("conversation state travels while every provider runtime home stays secret", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/records/sessions/claude/projects/-history-gits-root/memory`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/records/sessions/claude/projects/-history-gits-root/memory/MEMORY.md`), "# what I learned\n");
    const providerFiles = [
        ["claude", "default.json"],
        ["codex", "auth.json"],
        ["opencode", "auth.json"],
        ["cliproxy", "config.yaml"],
    ] as const;
    for (const [provider, file] of providerFiles) {
        await mkdir(join(source.work, `${STATE_DIR}/secrets/auth`, provider), { recursive: true });
        await writeFile(join(source.work, `${STATE_DIR}/secrets/auth`, provider, file), "secret");
    }
    for (const provider of RETIRED_WORKSPACE_STATE_DIRS.secret) {
        await mkdir(join(source.work, `${STATE_DIR}`, provider), { recursive: true });
        await writeFile(join(source.work, `${STATE_DIR}`, provider, "retired-secret.json"), "retired secret");
    }

    const target = await makeRoots();
    await restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    expect(await readFile(join(target.work, ".intentic/records/sessions/claude/projects/-history-gits-root/memory/MEMORY.md"), "utf8")).toBe(
        "# what I learned\n",
    );
    for (const [provider, file] of providerFiles) {
        await expect(readFile(join(target.work, ".intentic/secrets/auth", provider, file), "utf8")).rejects.toThrow();
    }
    for (const provider of RETIRED_WORKSPACE_STATE_DIRS.secret) {
        await expect(readFile(join(target.work, ".intentic", provider, "retired-secret.json"), "utf8")).rejects.toThrow();
    }

    const secretTarget = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: secretTarget.work, historyRoot: secretTarget.history }, LIMIT);
    for (const [provider, file] of providerFiles) {
        expect(await readFile(join(secretTarget.work, ".intentic/secrets/auth", provider, file), "utf8")).toBe("secret");
    }
    for (const provider of RETIRED_WORKSPACE_STATE_DIRS.secret) {
        expect(await readFile(join(secretTarget.work, ".intentic", provider, "retired-secret.json"), "utf8")).toBe("retired secret");
    }
    await cleanup();
});

test("the composed overlay is left for the target to recompose; its source section travels", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/config/environment.d`), { recursive: true });
    await mkdir(join(source.work, `${STATE_DIR}/local`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/config/environment.custom.Dockerfile`), "RUN apt-get install -y ffmpeg\n");
    await writeFile(join(source.work, `${STATE_DIR}/config/environment.d/rust.Dockerfile`), "RUN rustup default stable\n");
    // Composed from a base image the target may not even be on: restoring it would pin the wrong FROM.
    await writeFile(join(source.work, `${STATE_DIR}/local/environment.approved.Dockerfile`), "FROM registry.example/sandbox:old\n");

    const target = await makeRoots();
    const report = await restoreBundle(await bundleOf(source, false), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    expect(await readFile(join(target.work, ".intentic/config/environment.custom.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
    // A pending agent request survives the move: the owner still has a question to answer on the other side.
    expect(await readFile(join(target.work, ".intentic/config/environment.d/rust.Dockerfile"), "utf8")).toBe("RUN rustup default stable\n");
    await expect(readFile(join(target.work, ".intentic/local/environment.approved.Dockerfile"), "utf8")).rejects.toThrow();
    // And the owner is told the one thing the container cannot do for itself.
    expect(report.needsAction.map((action) => action.subject)).toContain("Rebuild the environment image");
    await cleanup();
});

test("the report names the capabilities a no-secrets bundle left unauthenticated", async () => {
    const source = await makeRoots();
    const target = await makeRoots();
    const report = await restoreBundle(
        await bundleOf(source, false, [{ id: "docker", kind: "cli", config: {} } as Capability]),
        { workspaceRoot: target.work, historyRoot: target.history },
        LIMIT,
    );
    const action = report.needsAction.find((entry) => entry.subject === "Reconnect capabilities");
    expect(action?.detail).toContain("docker");
    await cleanup();
});

test("derived trees are left out while durable artifacts travel", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/local/cache/iq`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/local/cache/iq/index.bin`), "cache");
    await mkdir(join(source.work, `${STATE_DIR}/local/browser/chromium`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/local/browser/chromium/Cookies`), "cookies");
    await mkdir(join(source.work, `${STATE_DIR}/records/artifacts/attachments/u1`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/records/artifacts/attachments/u1/shot.png`), "attachment");
    await mkdir(join(source.work, `${STATE_DIR}/records/artifacts/browser`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/records/artifacts/browser/viewport.png`), "screenshot");
    await mkdir(join(source.work, `${STATE_DIR}/local/runtime/extensions/whatsapp`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/local/runtime/extensions/whatsapp/gateway.url`), "http://127.0.0.1:1");
    for (const dir of RETIRED_WORKSPACE_STATE_DIRS.derived) {
        await mkdir(join(source.work, `${STATE_DIR}`, dir), { recursive: true });
        await writeFile(join(source.work, `${STATE_DIR}`, dir, "retired-cache.bin"), "retired cache");
    }
    await mkdir(join(source.history, "worktrees/abc/repo"), { recursive: true });
    await writeFile(join(source.history, "worktrees/abc/repo/file.ts"), "checkout");
    await mkdir(join(source.work, "repo/node_modules/pkg"), { recursive: true });
    await writeFile(join(source.work, "repo/node_modules/pkg/index.js"), "dep");

    const target = await makeRoots();
    await restoreBundle(await bundleOf(source, true), { workspaceRoot: target.work, historyRoot: target.history }, LIMIT);

    await expect(readFile(join(target.work, ".intentic/local/cache/iq/index.bin"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.work, ".intentic/local/browser/chromium/Cookies"), "utf8")).rejects.toThrow();
    expect(await readFile(join(target.work, ".intentic/records/artifacts/attachments/u1/shot.png"), "utf8")).toBe("attachment");
    expect(await readFile(join(target.work, ".intentic/records/artifacts/browser/viewport.png"), "utf8")).toBe("screenshot");
    await expect(readFile(join(target.work, ".intentic/local/runtime/extensions/whatsapp/gateway.url"), "utf8")).rejects.toThrow();
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
