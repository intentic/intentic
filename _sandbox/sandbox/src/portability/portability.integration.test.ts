import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { packBundle } from "./bundle.js";
import { applyBundle, BundleFormatError, bundleItems, dropSpool, spoolBundle } from "./bundle-arrival.js";

/* THE ROUND TRIP: export a sandbox's two volumes, take them into empty ones, and check that what came out is
 * what went in. The claim this suite exists to hold is the one the feature was asked for: "export and then
 * import result in the same environment". Anything the bundle deliberately does NOT carry is asserted just as
 * hard as what it does, because a silent omission is the failure mode that made this feature necessary.
 *
 * A BUNDLE ARRIVES THROUGH A PLAN NOW, so `arrive` below is spool → items → apply rather than one call. The
 * default is every row ticked, which is the old behaviour exactly; the tests that care about a subset name it.
 * The second consent moved with it: what is IN the file is still the exporter's `secrets` choice, and whether
 * the credential-classed entries are WRITTEN is now the receiving owner's `includeSecrets`, so the tests
 * about secrets assert both axes rather than one.
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

/* Take a bundle in, end to end: spool it, read the plan it produces, apply the ticked rows, drop the spool.
 * `pick` narrows the rows for the one test that needs to decline something; everything else takes the lot. */
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
    const { report } = await arrive(await bundleOf(source, false), target);

    expect(await readFile(join(target.work, "repo/src/main.ts"), "utf8")).toBe("export const x = 1;\n");
    // The mode is the assertion that separates this from the folder-drop path, which writes every file 0644.
    expect((await stat(join(target.work, "repo/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(target.work, "repo/link.ts"), "utf8")).toBe("export const x = 1;\n");
    expect((await stat(join(target.work, "empty-on-purpose"))).isDirectory()).toBe(true);
    // `repo` here is a plain directory with no .git, so the whole tree is the one "Workspace files" row.
    expect(report.applied.map((entry) => entry.id)).toEqual(["bundle:files"]);
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
    const { plan, report } = await arrive(await bundleOf(source, false), target);

    /* A REPOSITORY IS ITS OWN ROW, which is the whole reason a bundle is worth previewing: "bring the sandbox,
     * leave the six-gigabyte monorepo" is a sentence an owner can now say. `root` is deliberately not one —
     * the workspace repo's git dir is as much a part of /work as the files it tracks. */
    expect(plan).toEqual(["bundle:files", "repo:nested"]);

    // The git dirs themselves came across…
    expect(await readFile(join(target.history, "gits/root/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(await readFile(join(target.history, "gits/nested/HEAD"), "utf8")).toBe("ref: refs/heads/agent/x\n");
    // …and both pointers now name the TARGET's historyRoot, not the source's. Without this the restored tree is
    // a pile of files answering `fatal: not a git repository` to every command.
    expect(await readFile(join(target.work, ".git"), "utf8")).toBe(`gitdir: ${join(target.history, "gits/root")}\n`);
    expect(await readFile(join(target.work, "nested/.git"), "utf8")).toBe(`gitdir: ${join(target.history, "gits/nested")}\n`);
    // Both rows landed, and the heal is reported rather than silent.
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

    // Ordinary settings travel even with secrets on…
    expect(await readFile(join(target.work, ".intentic/config/settings.json"), "utf8")).toBe(`{"autoLand":true}`);
    // …the two identity files do not, and `secrets: true` does not buy them. Carrying owner.json would hand the
    // target's ownership to whoever holds the bundle.
    await expect(readFile(join(target.work, ".intentic/identity/owner.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "session-secret"), "utf8")).rejects.toThrow();
    expect(report.refused).toEqual([]);
    await cleanup();
});

/* TWO CONSENTS, NOT ONE, and this test is where the difference is asserted.
 *
 * The exporter decides what goes INTO the file, which is what makes a bundle safe to hand over or not. The
 * receiving owner decides what comes OUT of it, on the way in, which is the consent that used to be missing
 * entirely: a bundle-with-secrets wrote its credentials wherever it was pointed, because the only person ever
 * asked was whoever packed it. Both have to hold for a credential to land. */
test("secrets obey the exporter's choice AND the receiving owner's, and need both", async () => {
    const source = await makeRoots();
    await mkdir(join(source.work, `${STATE_DIR}/secrets`), { recursive: true });
    await writeFile(join(source.work, `${STATE_DIR}/secrets/ci.json`), `{"secret":"webhook"}`);

    // Never packed: nothing to consent to on the other side.
    const notPacked = await makeRoots();
    await arrive(await bundleOf(source, false), notPacked, { includeSecrets: true });
    await expect(readFile(join(notPacked.work, ".intentic/secrets/ci.json"), "utf8")).rejects.toThrow();

    // Packed, and declined on arrival: still not written, and the report says so rather than staying quiet.
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
    // Composed from a base image the target may not even be on: restoring it would pin the wrong FROM.
    await writeFile(join(source.work, `${STATE_DIR}/local/environment.approved.Dockerfile`), "FROM registry.example/sandbox:old\n");

    const target = await makeRoots();
    const { report } = await arrive(await bundleOf(source, false), target);

    expect(await readFile(join(target.work, ".intentic/config/environment.custom.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
    // A pending agent request survives the move: the owner still has a question to answer on the other side.
    expect(await readFile(join(target.work, ".intentic/config/environment.d/rust.Dockerfile"), "utf8")).toBe("RUN rustup default stable\n");
    await expect(readFile(join(target.work, ".intentic/local/environment.approved.Dockerfile"), "utf8")).rejects.toThrow();
    // And the owner is told the one thing the container cannot do for itself.
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
    // The volume defaults to SKIP: a file no manifest claims is either junk from a build that moved on or state
    // this daemon has no name for, and neither belongs in a bundle.
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
    // And the spool it started is gone: a refused read leaves no file behind to be swept later.
    await expect(readFile(join(target.history, "arrivals"), "utf8")).rejects.toThrow();
    await cleanup();
});

test("a bundle whose manifest this daemon cannot read is refused by version, not guessed at", async () => {
    const source = await makeRoots();
    const target = await makeRoots();
    // Round-trip a real bundle first so the happy path is known-good in this same suite…
    await expect(arrive(await bundleOf(source, false), target)).resolves.toBeDefined();
    // …then prove the guard: BundleFormatError is what the route turns into a 400.
    expect(new BundleFormatError("x")).toBeInstanceOf(Error);
    await cleanup();
});

/* THE POINT OF PREVIEWING A BUNDLE AT ALL. Before this, taking one in was all-or-nothing and it happened on
 * file pick, so "I want the sandbox but not that repository" had no answer short of deleting the directory
 * afterwards — on the most destructive of the four arrivals, the only one that lands OVER a workspace. */
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

    // The row was offered…
    expect(plan).toContain("repo:huge");
    // …and declining it left BOTH halves behind: a tree without its git dir would be a pile of files, and a
    // git dir without its tree would be dead weight on the history volume.
    expect(report.applied.map((entry) => entry.id)).toEqual(["bundle:files"]);
    await expect(readFile(join(target.work, "huge/blob.bin"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target.history, "gits/huge/HEAD"), "utf8")).rejects.toThrow();
    // While everything outside it came across as usual.
    expect(await readFile(join(target.work, "notes.md"), "utf8")).toBe("# keep me\n");
    await cleanup();
});
