import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { discardPaths } from "../git/changes.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../platform/perf.js";
import { isolatedAgent, noIsolation } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createExpiryTracker } from "./expiry.js";
import { createLandedPresences } from "./landed-presence.js";
import { landAgent } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

/* THE DISCARD CASE, end to end and against real git — because it is precisely the case no sha can report.
 *
 * A land leaves its delta in the main tree as UNCOMMITTED changes. Discard them in the Changes panel and no
 * commit anywhere moves: the branch tip is where it was, main's HEAD is where it was, and the recorded
 * landedTip still says the work went in. So a stub of any of those would prove nothing here — the whole point
 * is what the WORKING TREE holds, which only a real one can answer.
 */

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

test("landed work still sitting in the tree reads as present — nothing to say", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    expect(await presences.refresh([isolatedAgent(landed.repos)])).toBe(false);
    // The steady state is SILENCE, not a reading of 2-of-2: a card that spent a line on the happy path would
    // spend it on nearly every card on the board.
    expect(presences.of("c1")).toBeUndefined();
});

test("discarding the whole land reads as removed from the workspace", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    // An untracked add and a tracked edit: discard DELETES the first and reverts the second, and both have to
    // count as gone. The tracked half is the one a diff can see; the untracked half needs the ls-files walk.
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await discardPaths(work, undefined);

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    // The verdict MOVED, which is what makes the board repaint — the roster read that heals the card.
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

test("committing the landed work is the strongest form of present — and never reported as missing", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const entry = isolatedAgent(landed.repos);

    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "keep it");

    const presences = createLandedPresences(worktrees, logger, createExpiryTracker());
    await presences.refresh([entry]);
    expect(presences.of("c1")).toBeUndefined();

    /* And it STAYS silent when the user edits that path again and throws the edit away — the landing is
     * settled, because history holds the agent's lines and a discard can only return the file to them. This is
     * the case that separates this reading from the Changes panel's attribution, where a commit is what ENDS
     * an agent's claim: here it is what makes it permanent. */
    await writeFile(join(work, "app.ts"), edited(9));
    await discardPaths(work, ["app.ts"]);
    await presences.refresh([entry]);
    expect(presences.of("c1")).toBeUndefined();
});

test("an ABSORBED landing is answered from the entry — fully present, and not one git command", async () => {
    const { worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    // The mark the attribution scan writes once history has taken every landed path (agents/origins.ts via
    // registry.markLandingAbsorbed) — here stamped directly, because what THIS module owes it is only the
    // reading: both sides of the fraction, from memory, before any head read.
    const entry = isolatedAgent(landed.repos.map((composed) => Object.assign({}, composed, { absorbed: 3 })));

    const calls: string[][] = [];
    const presences = createLandedPresences(worktrees, logger, createExpiryTracker(), (dir, args, env) => {
        calls.push([...args]);
        return defaultGit(dir, args, env);
    });
    expect(await presences.refresh([entry])).toBe(false);
    // Absorbed is this reading's strongest "present": nothing missing, so nothing to say — and nothing spent.
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

    /* The default span is EMPTY here, and that is the whole problem stated as a test: every sha says this work
     * landed — because it did — so "Land now" would report success and carry nothing at all. */
    const remainder = await landAgent(worktrees, entry, "check", "outstanding");
    expect(remainder.changed).toBe(false);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(`${LINES.join("\n")}\n`);

    const again = await landAgent(worktrees, entry, "check", "cumulative");
    expect(again.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(edited(1));

    // And the card goes quiet again, because the work is back where the land put it.
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

    // The user keeps half and throws the other half away — the ordinary shape of a partial review.
    await sh(work, "add", "other.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "keep other.ts");
    await discardPaths(work, ["app.ts"]);

    const again = await landAgent(worktrees, entry, "check", "cumulative");
    // No conflict: the committed path un-applies cleanly, so it drops out of the patch rather than refusing it
    // — the same reverse probe that keeps work which reached main by another road out of a conflict report.
    expect(again.conflicts).toBeUndefined();
    expect(again.landed).toBe(true);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe(edited(1));
    // The kept half is untouched — one commit, not two, and no second copy of its hunk.
    expect(await sh(work, "status", "--porcelain", "other.ts")).toBe("");
});
