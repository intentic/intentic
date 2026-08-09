import type { RewindResult } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { rewindConversation, type RewindDeps } from "./rewind.js";
import type { TurnAnchor } from "./turn-anchors.js";

const CONVERSATION = "conv-1";

// Only the services rewind touches, each recording what it was asked to do — the point of these tests is the
// ORDER and the GUARD, not what git or the filesystem do underneath (history.integration.test.ts covers that
// end).
const deps = (overrides: {
    readonly running?: boolean;
    // null ⇒ the message has no anchor at all; omitted ⇒ the ordinary main-tree checkpoint.
    readonly anchor?: TurnAnchor | null;
    readonly restored?: boolean;
    readonly entry?: boolean;
    // Which repos of a worktree anchor refuse to reset — the checkout that is no longer there.
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
                // Every step asserts the lease is still held: a rewind that released early would be doing its
                // destructive work with turns admissible again, which is the whole failure this guards.
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
    /* Stands in for git in the isolated arm: records the command per repo and fails for the repos the case
     * names, which is how "that checkout is gone" is expressed without a filesystem. */
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

test("restores, truncates and clears the session — in that order, all under the lease", async () => {
    const { services, calls } = deps({});
    const outcome = (await rewindConversation(services, CONVERSATION, 2)) as RewindResult;

    expect(outcome).toEqual({ snapshot: "snap-1", dropped: 4 });
    // Files before transcript: a failed restore must leave the conversation intact, because a transcript cut
    // against a workspace that never moved is the one state with no way back.
    expect(calls).toEqual(["of", "restore", "truncate:2", "forgetAnchors:3", "clearSession"]);
});

test("a running turn refuses the rewind before anything is touched", async () => {
    const { services, calls } = deps({ running: true });
    expect(await rewindConversation(services, CONVERSATION, 2)).toBe("busy");
    // Not "it restored and then failed" — nothing ran at all, which is what makes the refusal safe.
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

// A conversation the registry has never seen still restores — the files are the part that matters, and there
// is no transcript to shorten.
test("an unknown conversation restores with nothing dropped", async () => {
    const { services, calls } = deps({ entry: false });
    expect(await rewindConversation(services, CONVERSATION, 2)).toEqual({ snapshot: "snap-1", dropped: 0 });
    expect(calls).toEqual(["of", "restore", "forgetAnchors:3", "clearSession"]);
});

/* THE ISOLATED ARM. A conversation working in a checkout of its own goes back to the commits its branch stood
 * on, not to a workspace checkpoint — the same three steps in the same order, in the currency it has. */
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

    // No `snapshot`: this rewind moved the conversation's own branch, and the workspace timeline has no row for
    // it — offering one would select a checkpoint that has nothing to do with what just happened.
    expect(outcome).toEqual({ dropped: 4 });
    expect(calls).toEqual(["of", "reset:root", "clean:root", "reset:intent", "clean:intent", "truncate:2", "forgetAnchors:3", "clearSession"]);
});

// One repo of the composition having lost its checkout is not the end of the rewind: the repos that ARE there
// are worth putting back, and an anchor covering some of them beats none.
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

// NONE of them resetting is the checkout being gone entirely, which is the same answer as a vanished
// checkpoint: there is nothing to go back to, and the transcript is left alone.
test("an isolated rewind with no checkout left refuses and leaves the transcript alone", async () => {
    const { services, calls, git } = deps({
        anchor: { kind: "worktree", repos: [{ repo: "gone", base: "sha-gone" }] },
        resetFails: ["gone"],
    });

    expect(await rewindConversation(services, CONVERSATION, 2, git)).toBe("no-checkpoint");
    expect(calls).toEqual(["of"]);
});
