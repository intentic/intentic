import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../../git/remote/root-repo.js";
import { discardPaths } from "../../git/changes/changes-index.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../platform/resources/perf.js";
import { isolatedAgent, noIsolation } from "../../testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createExpiryTracker } from "../registry/expiry.js";
import { createLandedPresences } from "./landed-presence.js";
import { landAgent } from "./land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../worktrees/worktrees.js";

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
