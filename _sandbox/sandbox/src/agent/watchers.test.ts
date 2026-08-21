import type { AgentTurn } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    armWatcher,
    armedWatcherCount,
    cancelWatcher,
    type CheckResult,
    listWatchers,
    MAX_PER_CONVERSATION,
    startWatcherRuntime,
    type WatcherRuntime,
    type WatcherSpec,
} from "./watchers.js";

const logger = pino({ level: "silent" });

/* The engine under fakes at every seam: the check answers from a script, delivery records what would have
 * become a steer or a wake turn. Fake timers drive the intervals: one advance per expected check, so a test
 * that fires early or late fails on the count, not just the outcome. */

interface Harness {
    readonly checks: string[];
    readonly steered: string[];
    readonly started: (AgentTurn & { conversationId: string })[];
    steerAnswer: boolean;
    startAnswer: boolean;
    check: CheckResult;
    stop: () => void;
}

const harnessOf = (over: Partial<Pick<Harness, "steerAnswer" | "startAnswer" | "check">> = {}): Harness => {
    const harness: Harness = {
        checks: [],
        steered: [],
        started: [],
        steerAnswer: false,
        startAnswer: true,
        check: { exitCode: 1, output: "still waiting" },
        stop: () => undefined,
        ...over,
    };
    const runtime: WatcherRuntime = {
        logger,
        runCheck: (command) => {
            harness.checks.push(command);
            return Promise.resolve(harness.check);
        },
        steer: (_conversationId, text) => {
            if (harness.steerAnswer) {
                harness.steered.push(text);
            }
            return harness.steerAnswer;
        },
        start: (turn) => {
            if (harness.startAnswer) {
                harness.started.push(turn);
            }
            return Promise.resolve(harness.startAnswer);
        },
        sessionIdOf: () => "session-9",
    };
    harness.stop = startWatcherRuntime(runtime);
    return harness;
};

const specOf = (over: Partial<WatcherSpec> = {}): WatcherSpec => ({
    conversationId: "conv-1",
    command: "ci-status --done",
    note: "CI run 316 on intentic/intentic",
    intervalSeconds: 10,
    timeoutSeconds: 60,
    cwd: "/work",
    env: {},
    turn: {},
    ...over,
});

describe("watchers", () => {
    let harness: Harness;
    beforeEach(() => {
        vi.useFakeTimers();
        harness = harnessOf();
    });
    afterEach(() => {
        harness.stop();
        vi.useRealTimers();
    });

    it("a first check that already passes arms nothing: no wake is owed", async () => {
        harness.check = { exitCode: 0, output: "done" };
        const outcome = await armWatcher(specOf());
        expect(outcome).toMatchObject({ kind: "already-met", firstCheck: { exitCode: 0, output: "done" } });
        expect(armedWatcherCount()).toBe(0);
    });

    it("fires once when the check flips to 0, waking the conversation with the check's own output", async () => {
        const outcome = await armWatcher(specOf());
        expect(outcome.kind).toBe("armed");
        expect(armedWatcherCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.started).toHaveLength(0);
        harness.check = { exitCode: 0, output: "conclusion: success" };
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.started).toHaveLength(1);
        const wake = harness.started[0] as AgentTurn & { conversationId: string };
        expect(wake.conversationId).toBe("conv-1");
        expect(wake.sessionId).toBe("session-9");
        expect(wake.prompt).toContain("condition you were watching is now met");
        expect(wake.prompt).toContain("CI run 316 on intentic/intentic");
        expect(wake.prompt).toContain("conclusion: success");
        // Fired means gone: no second wake, no lingering record.
        expect(armedWatcherCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.started).toHaveLength(1);
    });

    it("the deadline wakes too, saying so: a broken check is never silence", async () => {
        await armWatcher(specOf({ timeoutSeconds: 60 }));
        harness.check = { exitCode: undefined, output: "curl: (6) could not resolve host" };
        // Six 10s intervals reach the 60s deadline; the check there reports the timeout.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.started).toHaveLength(1);
        const wake = harness.started[0] as AgentTurn & { conversationId: string };
        expect(wake.prompt).toContain("timed out");
        expect(wake.prompt).toContain("could not resolve host");
        expect(wake.prompt).toContain("none (check was killed or failed to start)");
        expect(armedWatcherCount()).toBe(0);
    });

    it("a stopped watch never wakes", async () => {
        const outcome = await armWatcher(specOf());
        const id = outcome.kind === "armed" ? outcome.id : "";
        expect(cancelWatcher("conv-1", id)).toBe(true);
        harness.check = { exitCode: 0, output: "done" };
        await vi.advanceTimersByTimeAsync(120_000);
        expect(harness.started).toHaveLength(0);
        expect(harness.steered).toHaveLength(0);
    });

    it("only the arming conversation may stop a watch", async () => {
        const outcome = await armWatcher(specOf());
        const id = outcome.kind === "armed" ? outcome.id : "";
        expect(cancelWatcher("conv-other", id)).toBe(false);
        expect(armedWatcherCount()).toBe(1);
    });

    it("a live turn takes the report as a steer instead of a new turn", async () => {
        harness.steerAnswer = true;
        await armWatcher(specOf());
        harness.check = { exitCode: 0, output: "done" };
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.steered).toHaveLength(1);
        expect(harness.started).toHaveLength(0);
    });

    it("delivery retries until the conversation is free: an unsteerable live turn only delays the wake", async () => {
        harness.startAnswer = false;
        await armWatcher(specOf());
        harness.check = { exitCode: 0, output: "done" };
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.started).toHaveLength(0);
        harness.startAnswer = true;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.started).toHaveLength(1);
    });

    it("the wake reproduces the arming turn's identity and posture", async () => {
        await armWatcher(specOf({ turn: { agent: "codex", account: "acct-2", model: "gpt-6", isolated: true, unattended: true } }));
        harness.check = { exitCode: 0, output: "done" };
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.started[0]).toMatchObject({ agent: "codex", account: "acct-2", model: "gpt-6", isolated: true, unattended: true });
    });

    it("a slow check reschedules from its completion: never overlapping itself", async () => {
        await armWatcher(specOf());
        expect(harness.checks).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.checks).toHaveLength(3);
    });

    it("holds the per-conversation budget and lists what is armed", async () => {
        for (let i = 0; i < MAX_PER_CONVERSATION; i += 1) {
            expect((await armWatcher(specOf({ note: `watch ${i}` }))).kind).toBe("armed");
        }
        expect((await armWatcher(specOf())).kind).toBe("refused");
        // Another conversation's budget is its own.
        expect((await armWatcher(specOf({ conversationId: "conv-2" }))).kind).toBe("armed");
        expect(listWatchers("conv-1")).toHaveLength(MAX_PER_CONVERSATION);
        expect(listWatchers("conv-2")).toHaveLength(1);
    });

    it("refuses to arm when the runtime is not wired", async () => {
        harness.stop();
        const outcome = await armWatcher(specOf());
        expect(outcome).toMatchObject({ kind: "refused" });
    });
});
