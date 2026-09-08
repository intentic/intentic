import type { AgentTurn } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryWatchJournal, type WatchJournal } from "./watch-journal.js";
import { watchProjection } from "./watch-state.js";
import {
    armWatcher,
    armedWatcherCount,
    cancelWatcher,
    cancelWatchersFor,
    type CheckResult,
    listWatchers,
    MAX_PER_CONVERSATION,
    restoreWatchers,
    startWatcherRuntime,
    type WatcherRuntime,
    type WatcherSpec,
} from "./watchers.js";

const logger = pino({ level: "silent" });

// Engine under fakes at every seam: the check answers from a script, delivery records what would have become a steer or
// a wake turn. Fake timers drive intervals, one advance per expected check, so a timing failure fails on the count, not
// just the outcome.

// The tree a watch checks in. A name, not a path anybody has to have: nothing here opens it.
const WORKTREE = "/work";

interface Harness {
    readonly checks: string[];
    readonly steered: string[];
    readonly started: (AgentTurn & { conversationId: string })[];
    // The environments checks actually ran with, so a test can assert what a restored watch was handed.
    readonly checkEnvs: Readonly<Record<string, string>>[];
    steerAnswer: boolean;
    startAnswer: boolean;
    check: CheckResult;
    // What the capability store answers today; a restore reads it fresh, so a test can rotate and check it lands.
    env: Record<string, string>;
    // Which conversations still exist. Emptied to model a card discarded while the daemon was down.
    live: Set<string>;
    // Which trees are still on disk, faked since this suite must not touch the real filesystem.
    trees: Set<string>;
    journal: WatchJournal;
    stop: () => void;
}

const harnessOf = (over: Partial<Pick<Harness, "steerAnswer" | "startAnswer" | "check" | "env" | "journal">> = {}): Harness => {
    const harness: Harness = {
        checks: [],
        steered: [],
        started: [],
        checkEnvs: [],
        steerAnswer: false,
        startAnswer: true,
        check: { exitCode: 1, output: "still waiting" },
        env: {},
        live: new Set(["conv-1", "conv-2", "conv-3"]),
        trees: new Set([WORKTREE]),
        journal: memoryWatchJournal(),
        stop: () => undefined,
        ...over,
    };
    const runtime: WatcherRuntime = {
        logger,
        runCheck: (command, options) => {
            harness.checks.push(command);
            harness.checkEnvs.push(options.env);
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
        journal: harness.journal,
        envOf: () => Promise.resolve(harness.env),
        conversationLive: (conversationId) => harness.live.has(conversationId),
        treeLive: (cwd) => Promise.resolve(harness.trees.has(cwd)),
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
    cwd: WORKTREE,
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
        // The card projection is module state; `stop` leaves an empty entry per held watch, unlike never-published.
        watchProjection.forget(["conv-1", "conv-2", "conv-3"]);
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
        expect(wake.prompt).toContain("CI run 316 on intentic/intentic");
        expect(wake.prompt).toContain("conclusion: success");
        expect(wake.prompt).not.toMatch(/timed out/i);
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
        expect(wake.prompt).toMatch(/timed out/i);
        expect(wake.prompt).toContain("could not resolve host");
        expect(wake.prompt).not.toContain("conclusion: success");
        expect(armedWatcherCount()).toBe(0);
    });

    it("a stopped watch never wakes", async () => {
        const outcome = await armWatcher(specOf());
        const id = outcome.kind === "armed" ? outcome.id : "";
        expect(await cancelWatcher("conv-1", id)).toBe(true);
        harness.check = { exitCode: 0, output: "done" };
        await vi.advanceTimersByTimeAsync(120_000);
        expect(harness.started).toHaveLength(0);
        expect(harness.steered).toHaveLength(0);
    });

    it("only the arming conversation may stop a watch", async () => {
        const outcome = await armWatcher(specOf());
        const id = outcome.kind === "armed" ? outcome.id : "";
        expect(await cancelWatcher("conv-other", id)).toBe(false);
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

    // What the fleet card is told, and when: everything a watch does happens between turns, so the projection is the
    // only channel by which a surface learns this conversation isn't finished after all.
    describe("what the card is told", () => {
        it("publishes the note, the cadence and the deadline the moment a watch is armed", async () => {
            await armWatcher(specOf({ intervalSeconds: 30, timeoutSeconds: 600 }));
            const published = watchProjection.of("conv-1");
            expect(published).toHaveLength(1);
            expect(published?.[0]).toMatchObject({ note: "CI run 316 on intentic/intentic", intervalSeconds: 30 });
            // A deadline, not a duration: the card counts down against its own clock, so it needs the instant.
            expect(published?.[0]?.deadlineAt).toBe(Date.now() + 600_000);
            // The check command is deliberately absent: shell text nobody can act on, and could carry a secret to a
            // screen.
            expect(published?.[0]).not.toHaveProperty("command");
        });

        // Nothing armed, nothing published: a conversation that never watched must not acquire an empty readout.
        it("publishes nothing at all for a first check that already passes", async () => {
            harness.check = { exitCode: 0, output: "done" };
            await armWatcher(specOf());
            expect(watchProjection.of("conv-1")).toBeUndefined();
        });

        // Firing clears the card, the half it cannot get wrong: the promise is kept, the wake is a turn in the
        // transcript. Empty rather than deleted, since empty is what the registry turns back into an absent field.
        it("clears the card when the watch fires", async () => {
            await armWatcher(specOf());
            harness.check = { exitCode: 0, output: "conclusion: success" };
            await vi.advanceTimersByTimeAsync(10_000);
            expect(watchProjection.of("conv-1")).toEqual([]);
        });

        it("clears the card when the deadline passes without the condition", async () => {
            await armWatcher(specOf({ timeoutSeconds: 60 }));
            await vi.advanceTimersByTimeAsync(70_000);
            expect(watchProjection.of("conv-1")).toEqual([]);
        });

        // The agent's own `watch stop`, and only the watch it names: the others are still promises.
        it("republishes what is left when the agent stops one of several", async () => {
            const first = await armWatcher(specOf({ note: "CI" }));
            await armWatcher(specOf({ note: "deploy" }));
            expect(watchProjection.of("conv-1")).toHaveLength(2);
            await cancelWatcher("conv-1", first.kind === "armed" ? first.id : "");
            expect(watchProjection.of("conv-1")?.map((entry) => entry.note)).toEqual(["deploy"]);
        });

        // The user's own press disarms every watch of the conversation; it answers how many it took, so a disarm can be
        // told from a no-op, and never reaches across conversations.
        it("disarms every watch of one conversation and leaves the others alone", async () => {
            await armWatcher(specOf({ note: "CI" }));
            await armWatcher(specOf({ note: "deploy" }));
            await armWatcher(specOf({ conversationId: "conv-2", note: "release" }));
            expect(await cancelWatchersFor("conv-1")).toBe(2);
            expect(watchProjection.of("conv-1")).toEqual([]);
            expect(watchProjection.of("conv-2")).toHaveLength(1);
            expect(armedWatcherCount()).toBe(1);
            // Disarmed means no wake, ever: the whole point of the press.
            await vi.advanceTimersByTimeAsync(120_000);
            expect(harness.started.filter((turn) => turn.conversationId === "conv-1")).toHaveLength(0);
        });

        it("reports nothing disarmed when a conversation was watching nothing", async () => {
            expect(await cancelWatchersFor("conv-3")).toBe(0);
        });
    });

    // Surviving the daemon, the ordinary case for a watch, not the edge one: container recreates happen on every
    // update. Modelled as a SIGKILL: the runtime and every in-memory record die with it, and only the journal crosses
    // into the next daemon.
    describe("across a restart", () => {
        // Kills the daemon and boots the next one onto the same journal; `downSeconds` moves the clock while nothing
        // can run. The trailing advance flushes microtasks rather than waiting: a wake decided during restore is
        // delivered on a promise chain the pass does not await.
        const restart = async (over: Partial<Pick<Harness, "check" | "env">> & { downSeconds?: number } = {}): Promise<void> => {
            const { downSeconds, ...runtime } = over;
            const { journal } = harness;
            harness.stop();
            if (downSeconds !== undefined) {
                await vi.advanceTimersByTimeAsync(downSeconds * 1000);
            }
            harness = harnessOf({ journal, ...runtime });
            await restoreWatchers();
            await vi.advanceTimersByTimeAsync(0);
        };

        it("re-arms a watch the daemon died under, and it still fires", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            await restart();
            expect(armedWatcherCount()).toBe(1);
            // Still the agent's own check, on the agent's own cadence.
            expect(harness.checks).toEqual(["ci-status --done"]);
            harness.check = { exitCode: 0, output: "conclusion: success" };
            await vi.advanceTimersByTimeAsync(10_000);
            expect(harness.started).toHaveLength(1);
            expect(harness.started[0]?.prompt).toContain("CI run 316 on intentic/intentic");
            expect(harness.started[0]?.prompt).toContain("conclusion: success");
        });

        // The likeliest way a rebuild ends, and why restore re-checks instead of only re-arming: the condition can
        // resolve while the container watching it is being recreated.
        it("wakes immediately when the condition was met while the daemon was down", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            await restart({ check: { exitCode: 0, output: "conclusion: success" } });
            expect(harness.started).toHaveLength(1);
            expect(harness.started[0]?.prompt).toContain("CI run 316 on intentic/intentic");
            expect(harness.started[0]?.prompt).toContain("conclusion: success");
            // Woken means over: nothing re-armed, nothing left on the card.
            expect(armedWatcherCount()).toBe(0);
            expect(watchProjection.of("conv-1")).toEqual([]);
        });

        // The ending the old in-memory design couldn't pay, since the deadline died with the timer's own record. Worded
        // as itself, not a timeout: the check stopped running partway through, a fact about the daemon, not the world.
        it("wakes with the restart ending when the deadline passed while the daemon was down", async () => {
            await armWatcher(specOf({ timeoutSeconds: 60 }));
            // Down for longer than the watch had left.
            await restart({ downSeconds: 120 });
            expect(harness.started).toHaveLength(1);
            const wake = harness.started[0] as AgentTurn & { conversationId: string };
            expect(wake.prompt).toMatch(/deadline passed.*restarting/i);
            expect(wake.prompt).toMatch(/re-checked/i);
            expect(wake.prompt).not.toContain("conclusion: success");
            expect(armedWatcherCount()).toBe(0);
        });

        // Both endings the agent was promised still hold after a restart, which is the invariant the whole
        // journal exists for: no watch ends in silence.
        it("still honours the deadline it was armed with, counted from the original arming", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            await restart();
            await vi.advanceTimersByTimeAsync(600_000);
            expect(harness.started).toHaveLength(1);
            expect(harness.started[0]?.prompt).toMatch(/timed out/i);
        });

        // No credential crosses the restart, only the names of the ones the arming turn had; values come from the live
        // capability store at boot, so a rotated token is picked up and a newly connected one isn't handed to a check
        // nobody re-authorised.
        it("rebuilds the check's environment from live credentials, narrowed to the arming turn's keys", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600, env: { TOKEN_CI: "old-token", REGION: "eu" } }));
            await restart({ env: { TOKEN_CI: "rotated-token", REGION: "eu", TOKEN_ADDED_LATER: "not-granted" } });
            expect(harness.checkEnvs[0]).toEqual({ TOKEN_CI: "rotated-token", REGION: "eu" });
        });

        // A revoked credential has no value to find; the check runs without it rather than with a stale copy.
        it("drops a key whose credential is gone rather than resurrecting the old value", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600, env: { TOKEN_CI: "old-token" } }));
            await restart({ env: {} });
            expect(harness.checkEnvs[0]).toEqual({});
        });

        // The visible half: a conversation waiting before the restart must not read as finished after it.
        it("puts the readout back on the card", async () => {
            await armWatcher(specOf({ intervalSeconds: 30, timeoutSeconds: 600, note: "CI green on intentic/intentic" }));
            await restart();
            expect(watchProjection.of("conv-1")).toMatchObject([{ note: "CI green on intentic/intentic", intervalSeconds: 30 }]);
        });

        // The ghost this feature could have introduced, and why every disarm awaits its journal drop: a stopped watch
        // must not come back at boot.
        it("does not resurrect a watch that was stopped before the restart", async () => {
            const outcome = await armWatcher(specOf({ timeoutSeconds: 600 }));
            await cancelWatcher("conv-1", outcome.kind === "armed" ? outcome.id : "");
            await restart({ check: { exitCode: 0, output: "done" } });
            expect(armedWatcherCount()).toBe(0);
            expect(harness.started).toHaveLength(0);
        });

        // Nor one that already fired: one wake per watch is the promise, and a restart is not a second chance.
        it("does not resurrect a watch that had already fired", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            harness.check = { exitCode: 0, output: "done" };
            await vi.advanceTimersByTimeAsync(10_000);
            expect(harness.started).toHaveLength(1);
            await restart({ check: { exitCode: 0, output: "done" } });
            expect(armedWatcherCount()).toBe(0);
            expect(harness.started).toHaveLength(0);
        });

        // A watch outliving its conversation is a timer that will try to start a turn nobody answers to; this is the
        // crash beating agents.routes's own disarm-on-discard there.
        it("drops a watch whose conversation did not survive, without waking anything", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            const { journal } = harness;
            harness.stop();
            harness = harnessOf({ journal, check: { exitCode: 0, output: "done" } });
            harness.live.delete("conv-1");
            await restoreWatchers();
            await vi.advanceTimersByTimeAsync(0);
            expect(armedWatcherCount()).toBe(0);
            expect(harness.started).toHaveLength(0);
            // And it is gone for good: the next boot must not re-litigate it.
            expect(await journal.list()).toHaveLength(0);
        });

        // The other staleness test: an isolated turn's worktree can be landed and removed while the daemon is down, so
        // the watch is dropped, off disk too, rather than re-run somewhere wrong.
        it("drops a watch whose tree was landed away, without waking anything", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            const { journal } = harness;
            harness.stop();
            harness = harnessOf({ journal, check: { exitCode: 0, output: "done" } });
            harness.trees.clear();
            await restoreWatchers();
            await vi.advanceTimersByTimeAsync(0);
            expect(armedWatcherCount()).toBe(0);
            expect(harness.started).toHaveLength(0);
            // The check never ran: there was nowhere to run it.
            expect(harness.checks).toHaveLength(0);
            expect(await journal.list()).toHaveLength(0);
        });

        // Ids come from a counter that resets with the process, while restored watches keep their armed ids, so a fresh
        // watch could collide with one already restored; a shared id would make `watch stop` ambiguous.
        it("does not hand a new watch an id a restored one already holds", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600, note: "restored" }));
            await restart();
            const armed = await armWatcher(specOf({ timeoutSeconds: 600, note: "fresh" }));
            expect(armedWatcherCount()).toBe(2);
            expect(listWatchers("conv-1").map((watch) => watch.id)).toHaveLength(new Set(listWatchers("conv-1").map((w) => w.id)).size);
            expect(armed.kind === "armed" ? armed.id : "").not.toBe("watch-1");
        });

        // The overwhelmingly common boot: nothing was armed, so the pass reads an empty journal and does nothing.
        it("does nothing when nothing was armed", async () => {
            await restart();
            expect(armedWatcherCount()).toBe(0);
            expect(harness.checks).toHaveLength(0);
        });
    });
});
