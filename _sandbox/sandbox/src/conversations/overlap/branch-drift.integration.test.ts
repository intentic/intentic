import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pino } from "pino";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { observeGitCommands } from "@intentic/base/git";
import type { ActivityEvent } from "@intentic/sandbox-contract/schemas/activity";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import type { Said } from "../../seams/turn-starter.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { createPerfTracker } from "../../system/resources/perf.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { NO_QUEUE } from "../actor/conversation-queue.js";
import { fleetStoreOver, memoryFleet } from "../registry/agents-registry.testing.js";
import type { IsolatedAgent } from "../registry/agents-store.js";
import { isolatedAgent } from "../registry/agents-store.testing.js";
import { landMarksOf } from "../registry/land-marks.js";
import { noIsolation } from "../worktrees/isolation.testing.js";
import { createAgentWorktrees } from "../worktrees/worktrees.js";
import { createDriftWatch, type DriftDeps, landedBy, mergeConflicts } from "./branch-drift.js";
import { DRIFT_OPENING } from "./branch-drift-news.js";
import { unlandedPaths } from "../land/branch/unlanded-paths.js";
import { createFilesInFlight } from "../files-in-flight.js";

// Pins held work found no longer merging into the line it lands on when that line moves, not at its land: tried only
// where the move touched one of its files, told once per finding, and a resolve turn asked once per drift, only where
// the conversation's work lands by itself.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const tempDirs: string[] = [];
afterEach(async () => {
    observeGitCommands(() => undefined);
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const APP = "line one\nline two\nline three\nline four\nline five\n";

// A workspace with one conversation whose finished work (line two of app.ts) waits on its branch.
const setup = async (overrides: Partial<IsolatedAgent> = {}) => {
    const base = await mkdtemp(join(tmpdir(), "intentic-drift-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), APP);
    await writeFile(join(work, "other.ts"), "other\n");
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf: createPerfTracker(logger),
    });
    const checkout = await worktrees.ensure("c1", []);
    await writeFile(join(checkout.cwd, "app.ts"), APP.replace("line two", "line two, the agent's"));
    await commit(checkout.cwd, "agent work");

    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    store.agents.save([isolatedAgent(checkout.repos, { id: "c1", ...overrides })]);
    const { agents } = memoryFleet(store);
    await agents.init();
    const inFlight = createFilesInFlight({ agents, read: (entry) => unlandedPaths(worktrees, entry), logger });

    const notices: string[] = [];
    const activity: string[] = [];
    const wakes: Said[] = [];
    const deps = unstubbed<DriftDeps>("services", {
        logger: pino({ level: "silent" }),
        agents: unstubbed<Services["agents"]>("agents", { ids: agents.ids, entry: agents.entry, amendLandMarks: agents.amendLandMarks }),
        conversations: unstubbed<Services["conversations"]>("conversations", { state: () => undefined, queued: () => NO_QUEUE, running: () => false }),
        agentWorktrees: worktrees,
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            append: async (_agent: unknown, rows: readonly TranscriptRow[]) => void notices.push(...rows.map((row) => row.text)),
        }),
        activity: unstubbed<Services["activity"]>("activity", { append: async (event: Omit<ActivityEvent, "id" | "at">) => void activity.push(event.content ?? "") }),
        turns: unstubbed<Services["turns"]>("turns", {
            say: async (said: Said) => {
                wakes.push(said);
                return { delivered: "started" as const };
            },
        }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        inFlight,
    });
    // Every merge a pass tries, by the commit it tried onto.
    const merges: string[] = [];
    observeGitCommands(({ args }) => {
        if (args.includes("merge-tree")) {
            merges.push(args.at(-2) ?? "");
        }
    });
    const pass = async (): Promise<void> => {
        await inFlight.refreshLive();
        await createdWatch.pass();
    };
    const createdWatch = createDriftWatch(deps);
    return { work, checkout, agents, inFlight, notices, activity, wakes, merges, pass };
};

// A commit on the main line, as a land's version commit names the conversation it landed for.
const landOnMain = async (work: string, content: string, by: string): Promise<void> => {
    await writeFile(join(work, "app.ts"), content);
    await commit(work, `landed\n\nConversation-Id: ${by}`);
};

test("merge-tree names the clashing files, and the log names who landed what they clash with", async () => {
    const { work, checkout } = await setup();
    const anchor = await sh(work, "rev-parse", "HEAD");
    await landOnMain(work, APP.replace("line two", "line two, theirs"), "c2");
    const head = await sh(work, "rev-parse", "HEAD");
    const tip = await sh(checkout.cwd, "rev-parse", "HEAD");
    expect(await mergeConflicts(work, anchor, head, tip)).toEqual(["app.ts"]);
    expect(await mergeConflicts(work, anchor, anchor, tip)).toEqual([]);
    expect(await landedBy(work, anchor, head, ["app.ts"])).toEqual(new Map([["app.ts", ["c2"]]]));
});

test("a move that touches none of the branch's files is not tried; one that clashes is said once, and clears when it merges", async () => {
    const { work, checkout, agents, notices, activity, wakes, merges, pass } = await setup();
    // Nothing moved under the branch yet: there is nothing to merge.
    await pass();
    expect(merges).toHaveLength(0);
    expect(landMarksOf(agents.entry("c1")).drift).toBeUndefined();

    // The main line moves elsewhere: the last verdict stands at the new commit, with no merge tried.
    await writeFile(join(work, "other.ts"), "other, moved\n");
    await commit(work, "elsewhere");
    await pass();
    expect(merges).toHaveLength(0);

    // Another conversation lands a change to the same line: tried, found, kept on the record and said, once.
    await landOnMain(work, APP.replace("line two", "line two, theirs"), "c2");
    await pass();
    expect(merges).toHaveLength(1);
    const drift = landMarksOf(agents.entry("c1")).drift;
    expect(drift?.repos).toEqual([{ repo: "root", onto: await sh(work, "rev-parse", "HEAD"), paths: [{ path: "app.ts", by: ["c2"] }] }]);
    expect(drift?.asked).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("1 file clash");
    expect(notices[0]).toContain("`c2`");
    expect(activity).toHaveLength(1);
    // Its work is held, not landing by itself: nothing starts a turn for it.
    expect(wakes).toHaveLength(0);

    // The line moves again on the same file: the record follows quietly, nothing is said twice.
    await landOnMain(work, APP.replace("line two", "line two, theirs again"), "c3");
    await pass();
    expect(notices).toHaveLength(1);
    expect(landMarksOf(agents.entry("c1")).drift?.repos[0]?.paths).toEqual([{ path: "app.ts", by: ["c3", "c2"] }]);

    // The agent takes the main line in: the branch merges again, and the mark goes.
    await sh(checkout.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "-X", "ours", "-m", "take main", await sh(work, "rev-parse", "HEAD"));
    await pass();
    expect(landMarksOf(agents.entry("c1")).drift).toBeUndefined();
});

test("work that lands by itself is asked to resolve, once per drift; a resolve that did not take is only said", async () => {
    const { work, checkout, agents, notices, wakes, pass } = await setup({ postures: { autoLand: true } });
    await landOnMain(work, APP.replace("line two", "line two, theirs"), "c2");
    await pass();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.voice).toBe("sandbox");
    expect(wakes[0]?.turn.conversationId).toBe("c1");
    expect(wakes[0]?.turn.errand).toBe("land-conflict");
    expect(wakes[0]?.turn.prompt.startsWith(DRIFT_OPENING)).toBe(true);
    expect(wakes[0]?.turn.prompt).toContain("app.ts (changed by `c2`, landed)");
    expect(landMarksOf(agents.entry("c1")).drift?.asked).toBe(true);
    // The asking turn opened on its own words: no notice besides them.
    expect(notices).toHaveLength(0);

    // Its turn committed more and still clashes: said again, never asked again until it merges.
    await writeFile(join(checkout.cwd, "app.ts"), APP.replace("line two", "line two, the agent's second go"));
    await commit(checkout.cwd, "agent work again");
    await pass();
    expect(wakes).toHaveLength(1);
    expect(notices).toHaveLength(1);
});
