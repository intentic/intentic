import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createResidentEngine, type ResidentEngine } from "@intentic/iq-engine";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { agentRepoChanges } from "../../conversations/land/agent-changes.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../../conversations/worktrees/worktrees.js";
import { workspacePaths } from "../workspace.js";
import { createCheckoutOverlays, NO_OVERLAY, overlaidView, overlayOf } from "./checkout-overlay.js";
import { resolveReference } from "./resolve-reference.js";

// A conversation's references against real git and the real resident index: the index sweeps the shared tree alone, so
// only the conversation's own change list can say what its checkout created or renamed. No stub stands in for either.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
const engines: ResidentEngine[] = [];
afterEach(async () => {
    for (const engine of engines.splice(0)) {
        await engine.close();
    }
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const write = async (root: string, path: string, content = "x\n"): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
};

// The shared tree with `files` committed, and conversation c1's checkout cut from it.
const setup = async (files: readonly string[]): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-refs-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    for (const file of files) {
        await write(work, file, `${file}\n`);
    }
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation(work, historyRoot), logger, perf });
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

// What workspace.resolve answers for c1: its checkout over the shared tree, the shared tree searched by a real index.
const resolverFor = (work: string, worktrees: AgentWorktrees, conversation: ConversationWorktree) => {
    const iq = createResidentEngine({ root: work });
    engines.push(iq);
    const overlays = createCheckoutOverlays({ changesOf: (entry, composed) => agentRepoChanges(worktrees, entry, composed, "cumulative"), logger });
    return async (reference: string) =>
        resolveReference(
            reference,
            work,
            overlaidView({
                checkout: conversation.cwd,
                shared: work,
                overlay: await overlays.of(isolatedAgent(conversation.repos)),
                matching: async (glob) => {
                    const outcome = await iq.run({
                        verb: "files",
                        query: glob,
                        scope: {},
                        render: { budget: 400, limit: 10 },
                        options: { globExact: true },
                        echo: `files "${glob}" --exact`,
                    });
                    return outcome.result.groups.map((group) => group.path);
                },
            }),
        );
};

test("a file the conversation created resolves from the short path its agent writes, though the shared index never saw it", async () => {
    const { work, worktrees, conversation } = await setup(["_os/os-image/disk.sh"]);
    await write(conversation.cwd, "_os/os-image/installer/bib-config.toml");
    const resolve = resolverFor(work, worktrees, conversation);
    expect(await resolve("os-image/installer/bib-config.toml")).toEqual({ path: "_os/os-image/installer/bib-config.toml" });
});

test("a file created and renamed in one turn is offered where it went, since git never saw the first name", async () => {
    const { work, worktrees, conversation } = await setup(["_os/os-image/disk.sh"]);
    await write(conversation.cwd, "_os/os-image/installer/bib-config.toml");
    const resolve = resolverFor(work, worktrees, conversation);
    expect(await resolve("installer/config.toml")).toEqual({ nearby: ["_os/os-image/installer/bib-config.toml"] });
});

test("a file the conversation renamed opens where it went, not as the stale copy the shared tree still holds", async () => {
    const { work, worktrees, conversation } = await setup(["_os/installer/config.toml", "src/app.ts"]);
    await sh(conversation.cwd, "mv", "_os/installer/config.toml", "_os/installer/bib-config.toml");
    await commit(conversation.cwd, "rename");
    const resolve = resolverFor(work, worktrees, conversation);
    const moved = { path: "_os/installer/bib-config.toml", renamedFrom: "_os/installer/config.toml" };
    expect(await resolve("_os/installer/config.toml")).toEqual(moved);
    expect(await resolve("installer/config.toml")).toEqual(moved);
    // An untouched file still answers from the shared index, as before.
    expect(await resolve("src/app.ts")).toEqual({ path: "src/app.ts" });
});

test("a file the conversation deleted is no candidate for a shorter mention, though the shared tree still has it", async () => {
    const { work, worktrees, conversation } = await setup(["a/lib/util.ts", "b/deep/lib/util.ts"]);
    await sh(conversation.cwd, "rm", "-q", "a/lib/util.ts");
    await commit(conversation.cwd, "drop it");
    const resolve = resolverFor(work, worktrees, conversation);
    expect(await resolve("lib/util.ts")).toEqual({ path: "b/deep/lib/util.ts" });
});

// Existence is the one answer read from disk: the checkout first, the shared tree after it, as a read falls back.
describe("overlaidView on real folders", () => {
    let shared: string;
    let checkout: string;
    beforeEach(async () => {
        shared = await mkdtemp(join(tmpdir(), "overlay-shared-"));
        checkout = await mkdtemp(join(tmpdir(), "overlay-checkout-"));
        tempDirs.push(shared, checkout);
    });

    test("answers for the conversation's own files, which the shared index has never seen", async () => {
        await write(checkout, "intentic/_os/README.md");
        const view = overlaidView({
            checkout,
            shared,
            overlay: overlayOf([{ repo: "intentic", changes: [{ path: "_os/README.md", status: "added" }] }]),
            matching: async () => [],
        });
        expect(view.exists("intentic/_os/README.md")).toBe(true);
        expect(await view.endingWith("_os/README.md", 10)).toEqual(["intentic/_os/README.md"]);
        expect(await view.inFolder("_os", 10)).toEqual(["intentic/_os/README.md"]);
    });

    test("drops a rename whose old name the checkout holds again: that is a file of its own", async () => {
        await write(checkout, "intentic/src/old.ts");
        const overlay = overlayOf([{ repo: "intentic", changes: [{ path: "src/new.ts", status: "renamed", from: "src/old.ts" }] }]);
        expect(overlaidView({ checkout, shared, overlay, matching: async () => [] }).renamed.size).toBe(0);
    });

    test("falls back to the shared tree for existence, as a read does", async () => {
        await write(shared, "intentic/src/untouched.ts");
        expect(overlaidView({ checkout, shared, overlay: NO_OVERLAY, matching: async () => [] }).exists("intentic/src/untouched.ts")).toBe(true);
    });
});
