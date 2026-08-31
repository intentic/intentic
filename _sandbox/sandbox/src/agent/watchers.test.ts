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

/* The engine under fakes at every seam: the check answers from a script, delivery records what would have
 * become a steer or a wake turn. Fake timers drive the intervals: one advance per expected check, so a test
 * that fires early or late fails on the count, not just the outcome. */

// The tree a watch checks in. A name, not a path anybody has to have: nothing here opens it.
const WORKTREE = "/work";

interface Harness {
    readonly checks: string[];
    readonly steered: string[];
    readonly started: (AgentTurn & { conversationId: string })[];
    // The environments checks actually ran with, so a test can assert what a restored watch was handed rather
    // than only that it ran at all.
    readonly checkEnvs: Readonly<Record<string, string>>[];
    steerAnswer: boolean;
    startAnswer: boolean;
    check: CheckResult;
    // What the capability store would answer today. A restore reads it fresh, which is the whole reason no
    // credential is journalled, so a test rotates a value here and asserts the new one reached the check.
    env: Record<string, string>;
    // Which conversations still exist. Emptied to model a card discarded while the daemon was down.
    live: Set<string>;
    /* Which trees are still on disk, faked for the same reason the conversations are: this suite runs under the
     * unit budget, where nothing may reach the machine (@intentic/testing/vitest). Read off the real filesystem
     * it made every assertion below conditional on the box having the directory `specOf` names, which the CI
     * container does not, and a restore that thinks every tree is gone drops every watch in silence. */
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
        /* The card projection is module state, exactly as it is in a live daemon, and `stop` leaves an EMPTY
         * entry behind for every conversation that held a watch (that is how the readout comes off the card).
         * Empty and never-published are different answers to "what is this conversation waiting for", so a
         * test that asserts the second one has to start from a projection nobody has written to. */
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

    /* WHAT THE FLEET CARD IS TOLD, and when. Everything a watch does happens between turns, so the projection
     * (watch-state.ts) is the only channel by which any surface learns that this conversation is not finished
     * after all: an unpublished arm is a card that reads `idle` right up until the wake turn appears out of
     * nowhere hours later. */
    describe("what the card is told", () => {
        it("publishes the note, the cadence and the deadline the moment a watch is armed", async () => {
            await armWatcher(specOf({ intervalSeconds: 30, timeoutSeconds: 600 }));
            const published = watchProjection.of("conv-1");
            expect(published).toHaveLength(1);
            expect(published?.[0]).toMatchObject({ note: "CI run 316 on intentic/intentic", intervalSeconds: 30 });
            // A deadline, not a duration: the card counts down against its own clock, so it needs the instant.
            expect(published?.[0]?.deadlineAt).toBe(Date.now() + 600_000);
            // The check COMMAND is deliberately absent: shell text nobody can act on from a board, and the one
            // field that could carry a secret reference onto a screen read over shoulders.
            expect(published?.[0]).not.toHaveProperty("command");
        });

        // Nothing armed, nothing published: a conversation that never watched anything must not acquire an
        // empty readout just because somebody asked it a question that already held.
        it("publishes nothing at all for a first check that already passes", async () => {
            harness.check = { exitCode: 0, output: "done" };
            await armWatcher(specOf());
            expect(watchProjection.of("conv-1")).toBeUndefined();
        });

        /* FIRING CLEARS IT, which is the half a card cannot get wrong: the promise has been kept, the wake is
         * a turn in the transcript, and a card still naming the condition would be advertising a wait that is
         * over. Empty rather than deleted, because empty is what the registry turns back into an absent field. */
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

        /* THE USER'S OWN PRESS (agents.stopWatching), which takes the lot: what a person means by "stop
         * watching" about a card is "stop this conversation waking itself up". It answers how many it took, so
         * the caller can tell a disarm from a no-op, and it never reaches across conversations. */
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

    /* SURVIVING THE DAEMON, which for a watch is the ordinary case and not the edge one: its whole life
     * happens between turns, and intentic recreates its own container on every update, every environment
     * approval and every dev-sandbox.sh swap. The restart is modelled the way it actually happens, a SIGKILL:
     * the runtime stops, every timer and every in-memory record goes with it, and the only thing that crosses
     * into the next daemon is the journal on the history volume. */
    describe("across a restart", () => {
        /* Kill this daemon and boot the next one onto the same journal, which is the only thing that crosses.
         * `harness` is reassigned so afterEach stops the live runtime rather than the dead one, `downSeconds`
         * is how long the box was off (the clock moves while no timer can run, exactly as it does during a
         * rebuild), and the trailing advance is a MICROTASK FLUSH, not a wait: a wake the pass decides on is
         * delivered on a promise chain the pass deliberately does not await (one undeliverable report must not
         * hold up restoring the other watches), so a test that asserted straight after the await would be
         * counting ticks rather than behaviour. */
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

        /* THE LIKELIEST WAY A REBUILD ENDS, and the reason restore re-checks instead of only re-arming: the
         * thing being watched is exactly the kind of thing that resolves while the container that was watching
         * it is being recreated. CI going green during the rebuild must wake the agent at boot, not an
         * interval later and not never. */
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

        /* THE ENDING THE OLD IN-MEMORY DESIGN OWED AND COULD NOT PAY, since the deadline died in the same
         * record as the timer. It is worded as itself rather than as a timeout: the check stopped running
         * partway through, which is a fact about us, not about the world. */
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

        /* NO CREDENTIAL CROSSES THE RESTART, only the names of the ones the arming turn had. The values come
         * from the capability store as it stands at boot, so a token rotated while the daemon was down is
         * picked up, and a capability CONNECTED while it was down is not quietly handed to a check nobody
         * re-authorised, because its name was never in the arming turn's set. */
        it("rebuilds the check's environment from live credentials, narrowed to the arming turn's keys", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600, env: { TOKEN_CI: "old-token", REGION: "eu" } }));
            await restart({ env: { TOKEN_CI: "rotated-token", REGION: "eu", TOKEN_ADDED_LATER: "not-granted" } });
            expect(harness.checkEnvs[0]).toEqual({ TOKEN_CI: "rotated-token", REGION: "eu" });
        });

        // A credential revoked while the daemon was down has no value to find, and the check runs without it
        // rather than with a stale copy: the check failing honestly is the right outcome, and it is one the
        // agent is told about, since the watch still ends in a wake either way.
        it("drops a key whose credential is gone rather than resurrecting the old value", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600, env: { TOKEN_CI: "old-token" } }));
            await restart({ env: {} });
            expect(harness.checkEnvs[0]).toEqual({});
        });

        // The visible half: a conversation that was waiting on something before the restart must not read as
        // finished after it, which is what the card said for every watch the old design lost.
        it("puts the readout back on the card", async () => {
            await armWatcher(specOf({ intervalSeconds: 30, timeoutSeconds: 600, note: "CI green on intentic/intentic" }));
            await restart();
            expect(watchProjection.of("conv-1")).toMatchObject([{ note: "CI green on intentic/intentic", intervalSeconds: 30 }]);
        });

        /* THE GHOST THIS FEATURE COULD HAVE INTRODUCED, and the reason every disarm awaits its journal drop:
         * a watch the user or the agent stopped must not come back at boot wearing the note they dismissed. */
        it("does not resurrect a watch that was stopped before the restart", async () => {
            const outcome = await armWatcher(specOf({ timeoutSeconds: 600 }));
            await cancelWatcher("conv-1", outcome.kind === "armed" ? outcome.id : "");
            await restart({ check: { exitCode: 0, output: "done" } });
            expect(armedWatcherCount()).toBe(0);
            expect(harness.started).toHaveLength(0);
        });

        // Nor one that already ended on its own: one wake per watch is the promise, and a restart is not a
        // second chance to keep it.
        it("does not resurrect a watch that had already fired", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600 }));
            harness.check = { exitCode: 0, output: "done" };
            await vi.advanceTimersByTimeAsync(10_000);
            expect(harness.started).toHaveLength(1);
            await restart({ check: { exitCode: 0, output: "done" } });
            expect(armedWatcherCount()).toBe(0);
            expect(harness.started).toHaveLength(0);
        });

        /* A watch outliving its conversation is not a stale readout, it is a timer that will eventually try to
         * start a turn on an id nothing answers to. agents.routes disarms on discard and purge; this is the
         * crash that beat it there. */
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

        /* The other staleness test, and the one this suite could not make until the check became a seam: an
         * isolated conversation's worktree is landed and removed while the daemon is down, so there is nowhere
         * to run the check. Re-running it somewhere else would answer about the wrong tree, so the watch is
         * dropped, off disk too, rather than re-armed. */
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

        /* Ids are handed out by a counter that resets with the process, while restored watches keep the ids
         * they were armed under, so `watch-1` can be taken before this daemon arms anything. Two watches
         * sharing an id would make `watch stop` ambiguous and let one disarm the other. */
        it("does not hand a new watch an id a restored one already holds", async () => {
            await armWatcher(specOf({ timeoutSeconds: 600, note: "restored" }));
            await restart();
            const armed = await armWatcher(specOf({ timeoutSeconds: 600, note: "fresh" }));
            expect(armedWatcherCount()).toBe(2);
            expect(listWatchers("conv-1").map((watch) => watch.id)).toHaveLength(new Set(listWatchers("conv-1").map((w) => w.id)).size);
            expect(armed.kind === "armed" ? armed.id : "").not.toBe("watch-1");
        });

        // The overwhelmingly common boot: nothing was armed, so the pass reads an empty journal and does
        // nothing at all, including not asking the capability store for an environment it has no use for.
        it("does nothing when nothing was armed", async () => {
            await restart();
            expect(armedWatcherCount()).toBe(0);
            expect(harness.checks).toHaveLength(0);
        });
    });
});
