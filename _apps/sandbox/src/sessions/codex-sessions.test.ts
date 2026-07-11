import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { locateCodexThread } from "./codex-sessions.js";

const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "codex-sessions-"));
    roots.push(root);
    return root;
};

// Write a codex rollout at <home>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl.
const writeRollout = async (home: string, threadId: string): Promise<void> => {
    const dir = join(home, "sessions", "2026", "07", "11");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `rollout-2026-07-11T00-00-00-${threadId}.jsonl`), "{}\n");
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("locates a thread minted under the fallback home (no accountId)", async () => {
    const base = join(await scratch(), "codex");
    await writeRollout(base, "thr-1");
    expect(await locateCodexThread(base, [{ home: join(base, "acc-1"), accountId: "acc-1" }], "thr-1")).toEqual({ home: base });
});

test("locates a thread minted under an account home (carries the accountId)", async () => {
    const base = join(await scratch(), "codex");
    const accountHome = join(base, "acc-1");
    await writeRollout(accountHome, "thr-2");
    expect(await locateCodexThread(base, [{ home: accountHome, accountId: "acc-1" }], "thr-2")).toEqual({ home: accountHome, accountId: "acc-1" });
});

test("returns undefined when no home owns the thread", async () => {
    const base = join(await scratch(), "codex");
    await writeRollout(base, "thr-1");
    expect(await locateCodexThread(base, [{ home: join(base, "acc-1"), accountId: "acc-1" }], "missing")).toBeUndefined();
});

test("the fallback scan does not match an account-home rollout (account homes nest under the fallback)", async () => {
    const base = join(await scratch(), "codex");
    // Only the account home holds the rollout; scanning the fallback's own sessions/ must not reach into it.
    await writeRollout(join(base, "acc-1"), "thr-3");
    expect(await locateCodexThread(base, [], "thr-3")).toBeUndefined();
    expect(await locateCodexThread(base, [{ home: join(base, "acc-1"), accountId: "acc-1" }], "thr-3")).toEqual({
        home: join(base, "acc-1"),
        accountId: "acc-1",
    });
});
