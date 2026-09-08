import type { RewindResult } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { rewindConversation, type RewindDeps } from "./rewind.js";
import type { TurnAnchor } from "./turn-anchors.js";

const CONVERSATION = "conv-1";

// Only the services rewind touches, each recording what it was asked; these tests are about order and the lease guard,
// not what git or the filesystem actually do.
const deps = (overrides: {
    readonly running?: boolean;
    // null ⇒ the message has no anchor at all; omitted ⇒ the ordinary main-tree checkpoint.
    readonly anchor?: TurnAnchor | null;
    readonly restored?: boolean;
    readonly entry?: boolean;
    // Which repos of a worktree anchor refuse to reset: the checkout that is no longer there.
    readonly resetFails?: readonly string[];
}) => {
    const calls: string[] = [];
    let leaseHeld = false;
    const services = {
        agents: {
            withRewindLease: async <T>(_id: string, fn: () => Promise<T>): Promise<T | undefined> => {
                if (overrides.running === true) {
                    return undefined;
                }
                leaseHeld = true;
                try {
                    return await fn();
                } finally {
                    leaseHeld = false;
                }
            },
            entry: () => (overrides.entry === false ? undefined : { id: CONVERSATION, provider: "claude", harness: "native" }),
            clearSession: async () => {
                // Every step asserts the lease is still held; releasing early would let turns run again mid-rewind.
                expect(leaseHeld).toBe(true);
                calls.push("clearSession");
            },
        },
        turnAnchors: {
            of: async () => {
                expect(leaseHeld).toBe(true);
                calls.push("of");
                return overrides.anchor === null ? undefined : (overrides.anchor ?? { kind: "tree", snapshot: "snap-1" });
            },
            truncate: async (_id: string, from: number) => {
                expect(leaseHeld).toBe(true);
                calls.push(`forgetAnchors:${from}`);
            },
        },
        agentWorktrees: { worktreeDir: (_id: string, repo: string) => `/history/worktrees/${CONVERSATION}/${repo}` },
        history: {
            restore: async () => {
                expect(leaseHeld).toBe(true);
                calls.push("restore");
                return overrides.restored ?? true;
            },
        },
        transcripts: {
            truncate: async (_agent: unknown, keep: number) => {
                expect(leaseHeld).toBe(true);
                calls.push(`truncate:${keep}`);
                return 4;
            },
        },
        logger: { warn: vi.fn() },
    } as unknown as RewindDeps;
    // Stands in for git in the isolated arm: records each command per repo, and fails for named repos to express a
    // missing checkout.
    const git = async (dir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
        expect(leaseHeld).toBe(true);
        const repo = dir.split("/").at(-1) ?? "";
        if (overrides.resetFails?.includes(repo) === true) {
            throw new Error(`no checkout at ${dir}`);
        }
        calls.push(`${args[0]}:${repo}`);
        return { stdout: "", stderr: "" };
    };
    return { services, calls, git };
};

test("restores, truncates and clears the session: in that order, all under the lease", async () => {
    const { services, calls } = deps({});
    const outcome = (await rewindConversation(services, CONVERSATION, 2)) as RewindResult;

    expect(outcome).toEqual({ snapshot: "snap-1", dropped: 4 });
    // Files before transcript, so a failed restore leaves the conversation intact rather than an unrecoverable
    // transcript cut.
    expect(calls).toEqual(["of", "restore", "truncate:2", "forgetAnchors:3", "clearSession"]);
});

test("a running turn refuses the rewind before anything is touched", async () => {
    const { services, calls } = deps({ running: true });
    expect(await rewindConversation(services, CONVERSATION, 2)).toBe("busy");
    expect(calls).toEqual([]);
});

test("a message with no anchor refuses without restoring or truncating", async () => {
    const { services, calls } = deps({ anchor: null });
    expect(await rewindConversation(services, CONVERSATION, 2)).toBe("no-checkpoint");
    expect(calls).toEqual(["of"]);
});

test("a checkpoint that vanishes between lookup and restore leaves the transcript alone", async () => {
    const { services, calls } = deps({ restored: false });
    expect(await rewindConversation(services, CONVERSATION, 2)).toBe("no-checkpoint");
    expect(calls).toEqual(["of", "restore"]);
});

// An unknown conversation still restores: files are what matters, and there's no transcript to shorten.
test("an unknown conversation restores with nothing dropped", async () => {
    const { services, calls } = deps({ entry: false });
    expect(await rewindConversation(services, CONVERSATION, 2)).toEqual({ snapshot: "snap-1", dropped: 0 });
    expect(calls).toEqual(["of", "restore", "forgetAnchors:3", "clearSession"]);
});

// An isolated conversation goes back to the commits its branch stood on, not a workspace checkpoint: the same three
// steps, different currency.
test("an isolated conversation resets its own checkout, per repo, and names no timeline point", async () => {
    const { services, calls, git } = deps({
        anchor: {
            kind: "worktree",
            repos: [
                { repo: "root", base: "sha-root" },
                { repo: "intent", base: "sha-intent" },
            ],
        },
    });

    const outcome = (await rewindConversation(services, CONVERSATION, 2, git)) as RewindResult;

    // No `snapshot`: this moved the conversation's own branch; the workspace timeline has no row for it.
    expect(outcome).toEqual({ dropped: 4 });
    expect(calls).toEqual(["of", "reset:root", "clean:root", "reset:intent", "clean:intent", "truncate:2", "forgetAnchors:3", "clearSession"]);
});

test("a repo whose checkout is gone is skipped, and the rest still go back", async () => {
    const { services, calls, git } = deps({
        anchor: {
            kind: "worktree",
            repos: [
                { repo: "root", base: "sha-root" },
                { repo: "gone", base: "sha-gone" },
            ],
        },
        resetFails: ["gone"],
    });

    expect(await rewindConversation(services, CONVERSATION, 2, git)).toEqual({ dropped: 4 });
    expect(calls).toEqual(["of", "reset:root", "clean:root", "truncate:2", "forgetAnchors:3", "clearSession"]);
});

// All repos failing is the same as a vanished checkpoint: nothing to go back to, transcript untouched.
test("an isolated rewind with no checkout left refuses and leaves the transcript alone", async () => {
    const { services, calls, git } = deps({
        anchor: { kind: "worktree", repos: [{ repo: "gone", base: "sha-gone" }] },
        resetFails: ["gone"],
    });

    expect(await rewindConversation(services, CONVERSATION, 2, git)).toBe("no-checkpoint");
    expect(calls).toEqual(["of"]);
});
