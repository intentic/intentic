import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentTurn, type Loop, LOOP_DIR } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fileLoopsStore } from "./loops-store.js";
import { loopRunning, runLoop, type TurnFn } from "./loop-runner.js";
import { loopProjectionOf } from "./loop-state.js";

/* The pump's ceilings, end to end. Every test here is about a way the loop STOPS, because that is the whole
 * risk surface: a loop that never converges and never gives up is the one failure mode that costs real money
 * with nobody watching.
 *
 * The tree is a temp dir with no git in it, so `treeDigest` answers the same empty digest every time — which
 * means "nothing changed" is the default and the stall detector is live in every test unless a test writes into
 * a repo. That is the right default here: it makes the stall test cheap and it keeps the other tests honest
 * about needing their own reason to stop.
 */

const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        loops: fileLoopsStore(join(root, "loops.json")),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        agents: unstubbed<Services["agents"]>("agents", { sessionIdOf: () => undefined }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { conversationDir: () => root }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { open: async () => {}, append: async () => {} }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

// A turn that does nothing but end, recording the prompt it was given. `events` lets a test add usage or an error.
const fakeTurn = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): TurnFn =>
    // eslint-disable-next-line require-yield
    async function* fake(_services, input: AgentTurn) {
        prompts.push(input.prompt);
        yield* events;
    };

const baseLoop = (conversationId: string): Loop => ({
    conversationId,
    goal: "the suite is green",
    prompt: "fix the top failure",
    context: "fresh",
    output: { kind: "claim" },
    checks: [],
    maxIterations: 3,
    stallLimit: 99,
    isolated: false,
});

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "loops-"));

test("a loop that never claims done runs to its iteration ceiling and settles `exhausted`", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const record = await services.loops.start(baseLoop("c1"), 1);
    await runLoop(services, record, fakeTurn(prompts));

    expect(prompts).toHaveLength(3);
    const settled = await services.loops.get("c1");
    expect(settled?.state).toBe("exhausted");
    expect(settled?.iterations).toHaveLength(3);
    // The card must end up saying what the record says — the projection is the only thing the fleet reads.
    expect(loopProjectionOf("c1")).toMatchObject({ state: "exhausted", iteration: 3 });
    expect(loopRunning("c1")).toBe(false);
});

test("each iteration is numbered and carries the goal — a fresh session is told both or it knows neither", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const record = await services.loops.start({ ...baseLoop("c2"), maxIterations: 2 }, 1);
    await runLoop(services, record, fakeTurn(prompts));

    expect(prompts[0]).toContain("Iteration 1 of at most 2");
    expect(prompts[1]).toContain("Iteration 2 of at most 2");
    for (const prompt of prompts) {
        expect(prompt).toContain("the suite is green");
        // `fresh` mode's memory rule — without it every iteration repeats the last one's dead end.
        expect(prompt).toContain("progress.md");
    }
});

test("a written verdict of done stops the loop on that iteration", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    await mkdir(join(root, LOOP_DIR, "c3"), { recursive: true });
    // The turn's own side effect is the verdict file, which is exactly how a `claim` iteration reports.
    const turn: TurnFn = async function* claiming(_services, input: AgentTurn) {
        const n = /Iteration (\d+)/.exec(input.prompt)?.[1] ?? "1";
        await writeFile(join(root, LOOP_DIR, "c3", `iteration-${n}.json`), JSON.stringify({ done: n === "2", reason: `pass ${n}` }));
        yield { kind: "done" } as AgentEvent;
    };
    const record = await services.loops.start(baseLoop("c3"), 1);
    await runLoop(services, record, turn);

    const settled = await services.loops.get("c3");
    expect(settled?.state).toBe("done");
    expect(settled?.iterations).toHaveLength(2);
    expect(settled?.iterations.at(-1)).toMatchObject({ outcome: "done", detail: "pass 2" });
});

test("a missing output file reads as not-done rather than as done — the safe direction", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const record = await services.loops.start({ ...baseLoop("c4"), maxIterations: 1 }, 1);
    await runLoop(services, record, fakeTurn([]));

    const settled = await services.loops.get("c4");
    expect(settled?.state).toBe("exhausted");
    expect(settled?.iterations[0]?.detail).toContain("No output file");
});

test("consecutive iterations that change nothing trip the stall limit before the iteration ceiling", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const record = await services.loops.start({ ...baseLoop("c5"), maxIterations: 20, stallLimit: 2 }, 1);
    await runLoop(services, record, fakeTurn(prompts));

    expect(prompts).toHaveLength(2);
    const settled = await services.loops.get("c5");
    expect(settled?.state).toBe("stalled");
    expect(settled?.iterations.every((entry) => !entry.changed)).toBe(true);
});

test("the spend ceiling ends the loop, and the iterations' own usage is what counts against it", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const spendy = fakeTurn(prompts, [{ kind: "usage", costUsd: 0.4 }, { kind: "done" }]);
    const record = await services.loops.start({ ...baseLoop("c6"), maxIterations: 20, stallLimit: 99, maxSpendUsd: 1 }, 1);
    await runLoop(services, record, spendy);

    // Three iterations spend $1.20, which is the first total at or past the ceiling; the fourth never starts.
    expect(prompts).toHaveLength(3);
    const settled = await services.loops.get("c6");
    expect(settled?.state).toBe("overspent");
    expect(settled?.detail).toContain("1.20");
});

test("an errored turn is an iteration outcome, not the end of the loop", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const prompts: string[] = [];
    const failing = fakeTurn(prompts, [{ kind: "error", message: "provider blipped" }, { kind: "done" }]);
    const record = await services.loops.start({ ...baseLoop("c7"), maxIterations: 2 }, 1);
    await runLoop(services, record, failing);

    // The whole point: a turn that died on a blip is what a loop exists to ride out.
    expect(prompts).toHaveLength(2);
    const settled = await services.loops.get("c7");
    expect(settled?.state).toBe("exhausted");
    expect(settled?.iterations.every((entry) => entry.outcome === "error")).toBe(true);
});

test("a `continue` loop resumes the session its last iteration reported; a `fresh` one never does", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const turns: AgentTurn[] = [];
    const sessioned: TurnFn = async function* withSession(_services, input: AgentTurn) {
        turns.push(input);
        yield { kind: "session", sessionId: `s${turns.length}` } as AgentEvent;
        yield { kind: "done" } as AgentEvent;
    };
    await runLoop(services, await services.loops.start({ ...baseLoop("c8"), context: "continue", maxIterations: 3 }, 1), sessioned);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s1", "s2"]);

    turns.length = 0;
    await runLoop(services, await services.loops.start({ ...baseLoop("c9"), context: "fresh", maxIterations: 3 }, 1), sessioned);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined, undefined]);
});

test("a second pump on one conversation is refused rather than raced", async () => {
    const root = tempRoot();
    const services = fakeServices(root);
    const record = await services.loops.start({ ...baseLoop("c10"), maxIterations: 1 }, 1);
    let seen = false;
    const slow: TurnFn = async function* watching() {
        // While this iteration is in flight the conversation must read as looping, and a second runLoop against
        // it must return without starting anything.
        seen = loopRunning("c10");
        const prompts: string[] = [];
        await runLoop(services, record, fakeTurn(prompts));
        expect(prompts).toHaveLength(0);
        yield { kind: "done" } as AgentEvent;
    };
    await runLoop(services, record, slow);
    expect(seen).toBe(true);
});
