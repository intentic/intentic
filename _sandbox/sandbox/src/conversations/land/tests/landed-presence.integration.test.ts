import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/base/git";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { discardPaths } from "../../../git/changes/changes-index.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { isolatedAgent, noIsolation } from "../../../testing.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { createExpiryTracker } from "../../registry/expiry.js";
import { createLandedPresences } from "../landed-presence.js";
import { landAgent } from "../land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../../worktrees/worktrees.js";

// Discard case, end to end, against real git: discarding a land's uncommitted delta moves no sha, so a stub would prove
// nothing here.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const edited = (line: number): string => `${LINES.map((text, index) => (index === line - 1 ? `${text} EDITED` : text)).join("\n")}\n`;

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-presence-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), `${LINES.join("\n")}\n`);
    await writeFile(join(work, "other.ts"), `${LINES.join("\n")}\n`);
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

test("landed work still sitting in the tree reads as present, nothing to say", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    expect(await presences.refresh([isolatedAgent(landed.repos)])).toBe(false);
    expect(presences.of("c1")).toBeUndefined();
});

test("discarding the whole land reads as removed from the workspace", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    // Untracked add and tracked edit: discard deletes the first and reverts the second, and both must count as gone.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await discardPaths(work, undefined);

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    expect(await presences.refresh([entry])).toBe(true);
    expect(presences.of("c1")).toEqual({ landed: 2, present: 0 });
});

test("discarding part of a land reads as the fraction that survived", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "other.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await discardPaths(work, ["app.ts"]);

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    await presences.refresh([entry]);
    expect(presences.of("c1")).toEqual({ landed: 2, present: 1 });
});

test("committing the landed work is the strongest form of present, and never reported as missing", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "keep it");

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    await presences.refresh([entry]);
    expect(presences.of("c1")).toBeUndefined();

    // Re-editing and discarding stays silent too: history holds the agent's lines, so a discard just returns to them.
    await writeFile(join(work, "app.ts"), edited(9));
    await discardPaths(work, ["app.ts"]);
    await presences.refresh([entry]);
    expect(presences.of("c1")).toBeUndefined();
});

test("an ABSORBED landing is answered from the entry: fully present, and not one git command", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    // Stamped directly here (the real mark is registry.markLandingAbsorbed): this module owes only the reading.
    const entry = isolatedAgent(landed.repos.map((composed) => Object.assign({}, composed, { absorbed: 3 })));

    const calls: string[][] = [];
    const presences = createLandedPresences(worktrees, logger, createExpiryTracker(), (dir, args, env) => {
        calls.push([...args]);
        return defaultGit(dir, args, env);
    });
    expect(await presences.refresh([entry])).toBe(false);
    expect(presences.of("c1")).toBeUndefined();
    expect(calls).toEqual([]);
});

test("a cumulative land puts discarded work back; the default span cannot", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await discardPaths(work, undefined);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(`${LINES.join("\n")}\n`);

    // Every sha says this work landed, so the default span carries nothing and reports changed:false, not a failure.
    const remainder = await landAgent(worktrees, entry, "check", "outstanding");
    expect(remainder.changed).toBe(false);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(`${LINES.join("\n")}\n`);

    const again = await landAgent(worktrees, entry, "check", "cumulative");
    expect(again.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(edited(1));

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    await presences.refresh([isolatedAgent(again.repos)]);
    expect(presences.of("c1")).toBeUndefined();
});

test("a cumulative land re-applies only what is missing, leaving committed work alone", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "other.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await sh(work, "add", "other.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "keep other.ts");
    await discardPaths(work, ["app.ts"]);

    const again = await landAgent(worktrees, entry, "check", "cumulative");
    // The committed path un-applies cleanly and drops out, the reverse probe that excuses other-road work.
    expect(again.conflicts).toBeUndefined();
    expect(again.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(edited(1));
    expect(await sh(work, "status", "--porcelain", "other.ts")).toBe("");
});

// Who took it out: read off who acted on the tree between two readings, named only when that is one party.
describe("who took landed work out", () => {
    const ORCHESTRATOR = { kind: "agent", id: "orchestrator" } as const;
    const ME = { kind: "person", email: "me@example.com", name: "Me" } as const;

    // A land read once while whole, so the reading after it is a removal this process watched happen.
    const landedAndRead = async () => {
        const { work, worktrees, conversation } = await setup();
        await writeFile(join(conversation.cwd, "app.ts"), edited(1));
        await writeFile(join(conversation.cwd, "other.ts"), edited(1));
        const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
        const entry = isolatedAgent(landed.repos);
        const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
        await presences.refresh([entry]);
        return { work, worktrees, entry, presences };
    };

    test("an agent at work in the tree while it went is named, and stays named while nothing more goes", async () => {
        const { work, entry, presences } = await landedAndRead();
        await discardPaths(work, ["app.ts"]);
        expect(await presences.refresh([entry], [ORCHESTRATOR])).toBe(true);
        expect(presences.of("c1")).toEqual({ landed: 2, present: 1, removedBy: ORCHESTRATOR });
        // A later reading with somebody else at work, and nothing more missing, keeps the name it had.
        expect(await presences.refresh([entry], [ME])).toBe(false);
        expect(presences.of("c1")).toEqual({ landed: 2, present: 1, removedBy: ORCHESTRATOR });
    });

    // A read git could not answer (a sha it cannot resolve, a repo mid-write) says nothing: counted as 0/0 it read as
    // "nothing missing" and wiped the name, which no later reading could recover.
    test("a reading git could not answer keeps the last one, name included", async () => {
        const { work, entry, presences } = await landedAndRead();
        await discardPaths(work, ["app.ts"]);
        await presences.refresh([entry], [ORCHESTRATOR]);
        const unreadable = {
            ...entry,
            placement: { ...entry.placement, repos: entry.placement.repos.map((repo) => ({ ...repo, landedTip: "f".repeat(40) })) },
        };
        expect(await presences.refresh([unreadable], [ME])).toBe(false);
        expect(presences.of("c1")).toEqual({ landed: 2, present: 1, removedBy: ORCHESTRATOR });
    });

    test("a person noted throwing changes away is named", async () => {
        const { work, entry, presences } = await landedAndRead();
        presences.note(ME);
        await discardPaths(work, undefined);
        await presences.refresh([entry]);
        expect(presences.of("c1")).toEqual({ landed: 2, present: 0, removedBy: ME });
    });

    test("two candidates, or none, name nobody", async () => {
        const { work, entry, presences } = await landedAndRead();
        presences.note(ME);
        await discardPaths(work, ["app.ts"]);
        await presences.refresh([entry], [ORCHESTRATOR]);
        expect(presences.of("c1")).toEqual({ landed: 2, present: 1 });
        // The window closed with that reading: the next removal is read off nobody.
        await discardPaths(work, ["other.ts"]);
        await presences.refresh([entry]);
        expect(presences.of("c1")).toEqual({ landed: 2, present: 0 });
    });

    test("a first reading in a fresh process takes the record's name, never the window's", async () => {
        const { work, worktrees, entry } = await landedAndRead();
        await discardPaths(work, undefined);
        const restarted = createLandedPresences(worktrees, logger, createExpiryTracker());
        expect(restarted.measured("c1")).toBe(false);
        const recorded = { ...entry, landing: { ...entry.landing, removedBy: ORCHESTRATOR } };
        await restarted.refresh([recorded], [ME]);
        expect(restarted.measured("c1")).toBe(true);
        expect(restarted.of("c1")?.removedBy).toEqual(ORCHESTRATOR);
    });
});
