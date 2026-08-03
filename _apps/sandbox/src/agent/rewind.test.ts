import type { RewindResult } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { rewindConversation, type RewindDeps } from "./rewind.js";

const CONVERSATION = "conv-1";

// Only the four services rewind touches, each recording what it was asked to do — the point of these tests is
// the ORDER and the GUARD, not what git or the filesystem do underneath (history.integration.test.ts covers
// that end).
const deps = (overrides: {
    readonly running?: boolean;
    // null ⇒ the message has no checkpoint; omitted ⇒ the ordinary one.
    readonly snapshot?: string | null;
    readonly restored?: boolean;
    readonly entry?: boolean;
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
        rewindPoints: {
            of: async () => {
                expect(leaseHeld).toBe(true);
                calls.push("of");
                return overrides.snapshot === null ? undefined : (overrides.snapshot ?? "snap-1");
            },
            truncate: async (_id: string, from: number) => {
                expect(leaseHeld).toBe(true);
                calls.push(`forgetPoints:${from}`);
            },
        },
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
    return { services, calls };
};

test("restores, truncates and clears the session — in that order, all under the lease", async () => {
    const { services, calls } = deps({});
    const outcome = (await rewindConversation(services, CONVERSATION, 2)) as RewindResult;

    expect(outcome).toEqual({ snapshot: "snap-1", dropped: 4 });
    // Files before transcript: a failed restore must leave the conversation intact, because a transcript cut
    // against a workspace that never moved is the one state with no way back.
    expect(calls).toEqual(["of", "restore", "truncate:2", "forgetPoints:3", "clearSession"]);
});

test("a running turn refuses the rewind before anything is touched", async () => {
    const { services, calls } = deps({ running: true });
    expect(await rewindConversation(services, CONVERSATION, 2)).toBe("busy");
    // Not "it restored and then failed" — nothing ran at all, which is what makes the refusal safe.
    expect(calls).toEqual([]);
});

test("a message with no checkpoint refuses without restoring or truncating", async () => {
    const { services, calls } = deps({ snapshot: null });
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
    expect(calls).toEqual(["of", "restore", "forgetPoints:3", "clearSession"]);
});
