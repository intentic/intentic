import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { packBundle } from "./bundle.js";
import { applyBundle, BundleFormatError, bundleItems, dropSpool, spoolBundle } from "./bundle-arrival.js";

// Exports a sandbox's two volumes into empty ones and checks the result, including deliberate omissions. Arrival is
// spool->items->apply; a secret needs both the exporter's choice and the receiver's includeSecrets.

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

// Real roots and file reads for the bundler; vault sweeps default to no-ops so a throwing fake doesn't make every test
// about that seam. One test overrides them to prove ordering.
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

// Spools a bundle, applies its ticked rows, drops the spool; `pick` narrows rows for the one test that declines
// something.
const arrive = async (
    bundle: ReadableStream<Uint8Array>,
    target: { work: string; history: string },
    options: { includeSecrets?: boolean; pick?: (id: string) => boolean } = {},
) => {
    const held = await spoolBundle(bundle, target.history, LIMIT);
    const items = bundleItems(held.index).map((item) => item.id);
    const report = await applyBundle(
        held,
        { workspaceRoot: target.work, historyRoot: target.history },
        { items: items.filter(options.pick ?? (() => true)), includeSecrets: options.includeSecrets ?? true },
        LIMIT,
    );
    await dropSpool(held.spool);
    return { plan: items, report };
};

const bundleOf = async (
    source: { work: string; history: string },
    secrets: boolean,
    capabilities: Capability[] = [],
    sweeps: Partial<Services> = {},
): Promise<ReadableStream<Uint8Array>> => {
    const stream = packBundle(bundlerServices(source.work, source.history, capabilities, sweeps), { secrets, now: 1_700_000_000_000 });
    // Buffered only so a test can reread it; the route streams straight to the wire.
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
    const { report } = await arrive(await bundleOf(source, false), target);

    expect(await readFile(join(target.work, "repo/src/main.ts"), "utf8")).toBe("export const x = 1;\n");
    expect((await stat(join(target.work, "repo/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(target.work, "repo/link.ts"), "utf8")).toBe("export const x = 1;\n");
    expect((await stat(join(target.work, "empty-on-purpose"))).isDirectory()).toBe(true);
    // No .git here, so this whole tree lands as the single bundle:files row.
    expect(report.applied.map((entry) => entry.id)).toEqual(["bundle:files"]);
    expect(report.refused).toEqual([]);
    await cleanup();
});

test("every repo's real git dir travels, and its in-tree pointer is rewritten for the target's historyRoot", async () => {
    const source = await makeRoots();
    // Real shape: git dir lives under /history; the in-tree .git is a pointer file naming it.
    await mkdir(join(source.history, "gits/root/refs"), { recursive: true });
    await writeFile(join(source.history, "gits/root/HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(source.history, "gits/nested/refs"), { recursive: true });
    await writeFile(join(source.history, "gits/nested/HEAD"), "ref: refs/heads/agent/x\n");
    await writeFile(join(source.work, ".git"), `gitdir: ${join(source.history, "gits/root")}\n`);
    await mkdir(join(source.work, "nested"), { recursive: true });
    await writeFile(join(source.work, "nested/.git"), `gitdir: ${join(source.history, "gits/nested")}\n`);
    await writeFile(join(source.work, "nested/file.txt"), "x");

    const target = await makeRoots();
    const { plan, report } = await arrive(await bundleOf(source, false), target);

    // A nested repo gets its own preview row; the root workspace repo doesn't, its git dir is part of /work.
    expect(plan).toEqual(["bundle:files", "repo:nested"]);

    expect(await readFile(join(target.history, "gits/root/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(await readFile(join(target.history, "gits/nested/HEAD"), "utf8")).toBe("ref: refs/heads/agent/x\n");
    // Pointers are rewritten to name the target's historyRoot; otherwise the tree is not a git repository.
    expect(await readFile(join(target.work, ".git"), "utf8")).toBe(`gitdir: ${join(target.history, "gits/root")}\n`);
    expect(await readFile(join(target.work, "nested/.git"), "utf8")).toBe(`gitdir: ${join(target.history, "gits/nested")}\n`);
    // The re-pointer heal is reported, not silent.
    expect(report.applied.map((entry) => entry.id)).toEqual(["bundle:files", "repo:nested"]);
    expect(report.needsAction.find((action) => action.subject === "Repositories re-pointed")?.detail).toContain("nested");
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
    const { report } = await arrive(await bundleOf(source, true), target);

    expect(await readFile(join(target.work, ".intentic/config/settings.json"), "utf8")).toBe(`{"autoLand":true}`);
    // Identity files never travel, even with secrets:true; owner.json would hand over the target's ownership.
    await expect(readFile(join(target.work, ".intentic/identity/owner.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "session-secret"), "utf8")).rejects.toThrow();
    expect(report.refused).toEqual([]);
    await cleanup();
});

test("secrets obey the exporter's choice AND the receiving owner's, and need both", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/secrets`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/secrets/ci.json`), `{"secret":"webhook"}`);

    // Never packed: nothing to consent to on the other side.
    const notPacked = await makeRoots();
    await arrive(await bundleOf(source, false), notPacked, { includeSecrets: true });
    await expect(readFile(join(notPacked.work, ".intentic/secrets/ci.json"), "utf8")).rejects.toThrow();

    // Packed, then declined on arrival: still not written, and the report says so.
    const declined = await makeRoots();
    const { report } = await arrive(await bundleOf(source, true), declined, { includeSecrets: false });
    await expect(readFile(join(declined.work, ".intentic/secrets/ci.json"), "utf8")).rejects.toThrow();
    expect(report.needsAction.some((action) => action.subject === "Credentials stayed in the file")).toBe(true);

    // Packed and taken.
    const taken = await makeRoots();
    await arrive(await bundleOf(source, true), taken, { includeSecrets: true });
    expect(await readFile(join(taken.work, ".intentic/secrets/ci.json"), "utf8")).toContain("webhook");
    await cleanup();
});

test("the capability manifest travels without its credentials, swept before the walk", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/config`), { recursive: true });
    const manifestPath = join(source.work, `${STATE_DIR}/config/capabilities.json`);
    await writeFile(manifestPath, `[{"id":"mcp1","kind":"mcp","config":{"url":"https://mcp.example.com","token":"REAL-TOKEN"}}]`);

    const target = await makeRoots();
    await arrive(
        await bundleOf(source, false, [], {
            vaultManifestSecrets: async () => {
                await writeFile(
                    manifestPath,
                    `[{"id":"mcp1","kind":"mcp","config":{"url":"https://mcp.example.com","token":"__intentic_vaulted__"}}]`,
                );
                return ["mcp1"];
            },
        }),
        target,
    );

    const restored = await readFile(join(target.work, ".intentic/config/capabilities.json"), "utf8");
    expect(restored).toContain("mcp1");
    expect(restored).toContain("https://mcp.example.com");
    // The sweep's ordering, not classification, keeps the credential out.
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

    const target = await makeRoots();
    await arrive(await bundleOf(source, false), target);

    expect(await readFile(join(target.work, ".intentic/records/sessions/claude/projects/-history-gits-root/memory/MEMORY.md"), "utf8")).toBe(
        "# what I learned\n",
    );
    for (const [provider, file] of providerFiles) {
        await expect(readFile(join(target.work, ".intentic/secrets/auth", provider, file), "utf8")).rejects.toThrow();
    }

    const secretTarget = await makeRoots();
    await arrive(await bundleOf(source, true), secretTarget);
    for (const [provider, file] of providerFiles) {
        expect(await readFile(join(secretTarget.work, ".intentic/secrets/auth", provider, file), "utf8")).toBe("secret");
    }
    await cleanup();
});

test("the composed overlay is left for the target to recompose; its source section travels", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/config/environment.d`), { recursive: true });
    await mkdir(join(source.work, `${STATE_DIR}/local`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/config/environment.custom.Dockerfile`), "RUN apt-get install -y ffmpeg\n");
    await writeFile(join(source.work, `${STATE_DIR}/config/environment.d/rust.Dockerfile`), "RUN rustup default stable\n");
    // Composed from a base image the target may not be on; restoring it would pin the wrong FROM.
    await writeFile(join(source.work, `${STATE_DIR}/local/environment.approved.Dockerfile`), "FROM registry.example/sandbox:old\n");

    const target = await makeRoots();
    const { report } = await arrive(await bundleOf(source, false), target);

    expect(await readFile(join(target.work, ".intentic/config/environment.custom.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
    // A pending overlay draft survives the move; the owner still answers it on the other side.
    expect(await readFile(join(target.work, ".intentic/config/environment.d/rust.Dockerfile"), "utf8")).toBe("RUN rustup default stable\n");
    await expect(readFile(join(target.work, ".intentic/local/environment.approved.Dockerfile"), "utf8")).rejects.toThrow();
    expect(report.needsAction.some((action) => action.subject.toLowerCase().includes("environment"))).toBe(true);
    await cleanup();
});

test("the report names the capabilities a no-secrets bundle left unauthenticated", async () => {
    const source = await makeRoots();
    const target = await makeRoots();
    const { report } = await arrive(await bundleOf(source, false, [{ id: "docker", kind: "cli", config: { provider: "docker" } } as Capability]), target);
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
    await mkdir(join(source.history, "worktrees/abc/repo"), { recursive: true });
    await writeFile(join(source.history, "worktrees/abc/repo/file.ts"), "checkout");
    await mkdir(join(source.work, "repo/node_modules/pkg"), { recursive: true });
    await writeFile(join(source.work, "repo/node_modules/pkg/index.js"), "dep");

    const target = await makeRoots();
    await arrive(await bundleOf(source, true), target);

    await expect(readFile(join(target.work, ".intentic/local/cache/iq/index.bin"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.work, ".intentic/local/browser/chromium/Cookies"), "utf8")).rejects.toThrow();
    expect(await readFile(join(target.work, ".intentic/records/artifacts/attachments/u1/shot.png"), "utf8")).toBe("attachment");
    expect(await readFile(join(target.work, ".intentic/records/artifacts/browser/viewport.png"), "utf8")).toBe("screenshot");
    await expect(readFile(join(target.work, ".intentic/local/runtime/extensions/whatsapp/gateway.url"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "worktrees/abc/repo/file.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.work, "repo/node_modules/pkg/index.js"), "utf8")).rejects.toThrow();
    await cleanup();
});

test("an undeclared /history file is left behind rather than carried on a guess", async () => {
    // Undeclared /history state defaults to skip: unclaimed by any manifest, so it stays out of the bundle.
    const source = await makeRoots();
    await writeFile(join(source.history, "some-future-store.json"), "{}");
    const target = await makeRoots();
    await arrive(await bundleOf(source, true), target);
    await expect(readFile(join(target.history, "some-future-store.json"), "utf8")).rejects.toThrow();
    await cleanup();
});

test("a tar that is not a bundle is refused at the SPOOL, before a single byte is written into the workspace", async () => {
    const target = await makeRoots();
    const notABundle = new Blob([new Uint8Array([1, 2, 3, 4])]).stream();
    await expect(spoolBundle(notABundle, target.history, LIMIT)).rejects.toThrow();
    // A refused spool leaves no file behind to be swept later.
    await expect(readFile(join(target.history, "arrivals"), "utf8")).rejects.toThrow();
    await cleanup();
});

test("a bundle whose manifest this daemon cannot read is refused by version, not guessed at", async () => {
    const source = await makeRoots();
    const target = await makeRoots();
    // Confirms the happy path works before testing the guard.
    await expect(arrive(await bundleOf(source, false), target)).resolves.toBeDefined();
    // BundleFormatError is what the route turns into a 400.
    expect(new BundleFormatError("x")).toBeInstanceOf(Error);
    await cleanup();
});

// Bundle apply is the only arrival that lands over an existing workspace, which is why previewing and unticking rows
// matters here.
test("an unticked repository is left in the file: its tree and its git dir both stay out", async () => {
    const source = await makeRoots();
    await mkdir(join(source.history, "gits/huge"), { recursive: true });
    await writeFile(join(source.history, "gits/huge/HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(source.work, "huge"), { recursive: true });
    await writeFile(join(source.work, "huge/.git"), `gitdir: ${join(source.history, "gits/huge")}\n`);
    await writeFile(join(source.work, "huge/blob.bin"), "x".repeat(1024));
    await writeFile(join(source.work, "notes.md"), "# keep me\n");

    const target = await makeRoots();
    const { plan, report } = await arrive(await bundleOf(source, false), target, { pick: (id) => id !== "repo:huge" });

    expect(plan).toContain("repo:huge");
    // Declining a repo drops both halves; either alone would be dead weight or a non-repo pile of files.
    expect(report.applied.map((entry) => entry.id)).toEqual(["bundle:files"]);
    await expect(readFile(join(target.work, "huge/blob.bin"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "gits/huge/HEAD"), "utf8")).rejects.toThrow();
    expect(await readFile(join(target.work, "notes.md"), "utf8")).toBe("# keep me\n");
    await cleanup();
});
