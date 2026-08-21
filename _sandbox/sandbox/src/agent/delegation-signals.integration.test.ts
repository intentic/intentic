import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchDelegationSignals, type DelegationSignalsWatcher } from "./delegation-signals.js";
import { listSubagentSessions, noteDelegation, resetSubagents, subagentSource, type SubagentTurn } from "./subagents.js";

/* The spool is the codex hook's half of the conversation (codex-config.ts writes the hook; this reads what it
 * drops). The suite writes the same files the hook script produces and asserts the roster heard them, and
 * that the spool is empty afterwards, because a spool that keeps its files re-folds them forever. */

const turn = (): SubagentTurn => ({ conversationId: "conv-1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: undefined });

const spawn = (id = "bash-1"): void => {
    noteDelegation(turn(), { id, command: "codex exec --dangerously-bypass-hook-trust 'do the thing'", background: true });
};

const signalFile = (dir: string, name: string, body: unknown): Promise<void> => writeFile(join(dir, name), `${JSON.stringify(body)}\n`);

let dir: string;
let watcher: DelegationSignalsWatcher | undefined;

beforeEach(async () => {
    resetSubagents();
    dir = await mkdtemp(join(tmpdir(), "agent-signals-"));
});
afterEach(() => {
    watcher?.close();
    watcher = undefined;
    vi.useRealTimers();
});

it("folds what is already in the spool at start, in stamp order, and empties it", async () => {
    spawn();
    await signalFile(dir, "sig-10-2.json", { source: "codex", action: "blocked", delegationId: "bash-1", payload: null });
    await signalFile(dir, "sig-10-1.json", {
        source: "codex",
        action: "session",
        delegationId: "bash-1",
        payload: { session_id: "019f-abc" },
    });
    watcher = await watchDelegationSignals(dir);
    // The stamp orders the pair: the session bind (…-1) folds before the blocked (…-2).
    expect(subagentSource("bash-1")).toMatchObject({ thread: "019f-abc" });
    expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "blocked" }]);
    expect(await readdir(dir)).toEqual([]);
});

it("hears a file dropped after start", async () => {
    spawn();
    watcher = await watchDelegationSignals(dir);
    await signalFile(dir, "sig-20-1.json", {
        source: "codex",
        action: "report",
        delegationId: "bash-1",
        payload: { last_assistant_message: "Ported the module; tests pass." },
    });
    await expect
        .poll(() => listSubagentSessions()[0], { timeout: 3_000 })
        .toMatchObject({ id: "bash-1", status: "completed", summary: "Ported the module; tests pass." });
    await expect.poll(() => readdir(dir), { timeout: 3_000 }).toEqual([]);
});

it("drops garbage and foreign files without stopping, and reports the parse failure", async () => {
    spawn();
    const errors: unknown[] = [];
    await writeFile(join(dir, "sig-30-1.json"), "not json at all");
    await signalFile(dir, "sig-30-2.json", { source: "someone-else", action: "blocked", delegationId: "bash-1" });
    await signalFile(dir, "sig-30-3.json", { source: "codex", action: "blocked", delegationId: "bash-1", payload: null });
    watcher = await watchDelegationSignals(dir, (error) => errors.push(error));
    // The garbage was reported, the foreign source ignored, and the real signal still landed.
    expect(errors).toHaveLength(1);
    expect(listSubagentSessions()).toMatchObject([{ id: "bash-1", status: "blocked" }]);
    expect(await readdir(dir)).toEqual([]);
});
