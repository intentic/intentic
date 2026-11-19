import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pino } from "pino";
import { unstubbed } from "@intentic/testing";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { noIsolation } from "../worktrees/isolation.testing.js";
import { createAgentWorktrees } from "../worktrees/worktrees.js";
import type { Services } from "../../composition.js";
import { createFilesInFlight } from "../files-in-flight.js";
import { endingStatus, type IsolatedAgent, type PersistedAgent } from "../registry/agents-store.js";
import { isolatedAgent } from "../registry/agents-store.testing.js";
import { fleetOverlapOf, fleetRefusedBy, indexedPath } from "./fleet-overlap.js";
import { fleetRosterPage, type FleetRecallDeps } from "./fleet-recall.js";

// Pins what `agents ls --touching` and `agents show` read off the files in flight and a drift's mark: who holds a path,
// whoever else changes the same files, and held work that stopped merging, named with who landed what it clashes with.

const ROOT = [{ repo: "root", base: "b0" }];
const titled = (id: string, title: string, overrides: Partial<IsolatedAgent> = {}): PersistedAgent =>
    isolatedAgent(ROOT, { id, social: { title: { text: title, source: "derived" }, reactions: [] }, updatedAt: 1, ...overrides });

const fleetOver = async (entries: readonly PersistedAgent[], files: Readonly<Partial<Record<string, readonly string[]>>>) => {
    const agents = { ids: () => entries.map((entry) => entry.id), entry: (id: string) => entries.find((entry) => entry.id === id) };
    const inFlight = createFilesInFlight({ agents, read: async (entry) => ({ paths: files[entry.id] ?? [], tips: new Map() }), logger: pino({ level: "silent" }) });
    await inFlight.refreshLive();
    const deps = unstubbed<FleetRecallDeps>("fleet", {
        agents: unstubbed<Services["agents"]>("agents", {
            ...agents,
            get: (id: string) => {
                const found = agents.entry(id);
                return found === undefined ? undefined : unstubbed("summary", { status: endingStatus(found.ending) });
            },
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", { running: () => false }),
        inFlight,
    });
    return deps;
};

test("--touching lists only the conversations holding the path or anything under it, each with what it holds there", async () => {
    const deps = await fleetOver([titled("jet-dewt", "Wasm loop"), titled("ash-fern", "Shaders"), titled("oak-moss", "Docs")], {
        "jet-dewt": ["client/src/loop.rs", "client/Cargo.toml"],
        "ash-fern": ["shaders/cache.rs"],
    });
    const page = fleetRosterPage(deps, { touching: "client" });
    expect(page.rows.map((row) => [row.id, row.touching])).toEqual([["jet-dewt", { paths: ["client/Cargo.toml", "client/src/loop.rs"], count: 2 }]]);
    expect(page.total).toBe(1);
    // Without it, the roster is whole and no row carries a match.
    expect(fleetRosterPage(deps).rows.every((row) => row.touching === undefined)).toBe(true);
});

test("show names the files in flight, who else changes them, and a drift with who landed what it clashes with", async () => {
    const drifting = titled("ash-fern", "Shaders", {
        landMarks: { drift: { at: 5, tips: "root@t", asked: true, repos: [{ repo: "root", onto: "c".repeat(40), paths: [{ path: "client/src/loop.rs", by: ["jet-dewt"] }], more: 2 }] } },
    });
    const deps = await fleetOver([titled("jet-dewt", "Wasm loop"), drifting], { "jet-dewt": ["client/src/loop.rs"], "ash-fern": ["client/src/loop.rs", "shaders/a.rs"] });
    expect(fleetOverlapOf(deps, drifting)).toEqual({
        files: 2,
        paths: ["client/src/loop.rs", "shaders/a.rs"],
        others: [{ id: "jet-dewt", title: "Wasm loop", paths: ["client/src/loop.rs"] }],
        drift: {
            since: 5,
            files: 3,
            asked: true,
            repos: [{ repo: "root", onto: "c".repeat(40), paths: [{ path: "client/src/loop.rs", by: [{ id: "jet-dewt", title: "Wasm loop" }] }], more: 2 }],
        },
    });
    expect(fleetRosterPage(deps).rows.find((row) => row.id === "ash-fern")?.drift).toEqual({ since: 5, files: 3 });
});

test("a path a shell typed is keyed as the index keys it, from the shared tree or a conversation's own checkout", () => {
    expect(indexedPath("/work/client/src/loop.rs", "/work", "/history/worktrees")).toBe("client/src/loop.rs");
    expect(indexedPath("/history/worktrees/ash-fern/client/src", "/work", "/history/worktrees")).toBe("client/src");
    expect(indexedPath("client/src", "/work", "/history/worktrees")).toBe("client/src");
    expect(indexedPath("/etc/hosts", "/work", "/history/worktrees")).toBe("/etc/hosts");
});

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();

test("a land refused on conflicts names, per clashing file, the conversations whose landed commits it met", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-refused-by-"));
    try {
        const work = join(base, "work");
        const historyRoot = join(base, "history");
        const workspace = workspacePaths(work);
        await mkdir(work, { recursive: true });
        await ensureRootRepo(workspace, historyRoot);
        await writeFile(join(work, "app.ts"), "one\ntwo\n");
        await git(work, "add", "-A");
        await git(work, "commit", "-qm", "baseline");
        const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
        const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation(work, historyRoot), logger, perf: createPerfTracker(logger) });
        const checkout = await worktrees.ensure("ash-fern", []);
        await writeFile(join(checkout.cwd, "app.ts"), "one\ntwo, mine\n");
        await git(checkout.cwd, "commit", "-qam", "mine");
        await writeFile(join(work, "app.ts"), "one\ntwo, theirs\n");
        await git(work, "commit", "-qam", "landed\n\nConversation-Id: jet-dewt");

        const refused = isolatedAgent(checkout.repos, { id: "ash-fern", landing: { conflicts: [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0 }] } });
        const lander = titled("jet-dewt", "Wasm loop");
        const deps = { agentWorktrees: worktrees, agents: { entry: (id: string) => [refused, lander].find((entry) => entry.id === id) } };
        expect(await fleetRefusedBy(deps, refused)).toEqual([{ repo: "root", paths: [{ path: "app.ts", by: [{ id: "jet-dewt", title: "Wasm loop" }] }] }]);
        // Nothing refused, nothing to name.
        expect(await fleetRefusedBy(deps, isolatedAgent(checkout.repos, { id: "ash-fern" }))).toBeUndefined();
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
