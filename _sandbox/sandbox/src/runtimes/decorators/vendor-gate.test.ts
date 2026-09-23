import type { AgentRequest, TurnHooks } from "../../agent/providers/agent-request.js";
import { parkedCards } from "../../agents/actor/parked-cards.js";
import { vendorSubject } from "../../guard/command-guard.js";
import { conversationTainted } from "../../guard/turn-taint.js";
import { memoryFleet } from "../../testing.js";
import { vendorTurnGate } from "./vendor-gate.js";

/* The groups a vendor loop's gate is minted from: what it judges by (policy), who judges (hooks), where (spec). */

const SUBJECT = vendorSubject("bash");

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const request = (
    over: { readonly policy?: AgentRequest["policy"]; readonly judge?: TurnHooks["judge"] } = {},
    conversationId?: string,
): Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal"> => ({
    spec: { prompt: "p", cwd: "/w", ...(conversationId === undefined ? {} : { conversationId }) },
    policy: over.policy ?? {},
    hooks: { cards, ...(over.judge === undefined ? {} : { judge: over.judge }) },
    signal: new AbortController().signal,
});

test("an outside wake in the policy is published under the spec's conversation until the gate is released", () => {
    const { release } = vendorTurnGate(request({ policy: { outsideWake: "discord" } }, "gate-c1"));
    expect(conversationTainted("gate-c1")).toBe(true);
    release();
    expect(conversationTainted("gate-c1")).toBe(false);
});

test("the policy's rulebook shapes the gate: a runtime with no seam is tainted for its whole life", () => {
    const { taint, release } = vendorTurnGate(request({ policy: { rulebook: "none" } }, "gate-c2"));
    expect(taint.tainted()).toBe(true);
    release();
});

test("the hooks' judge is the one asked, and a refuse-only runtime refuses what it would have held", async () => {
    const asked: string[] = [];
    const { gate, release } = vendorTurnGate(
        request({
            policy: { rulebook: "refuse-only" },
            judge: async (program) => {
                asked.push(program);
                return { decision: "ask", sentence: "Discards whatever commits origin has." };
            },
        }),
    );
    const step = await gate.consult("git push --force origin main", SUBJECT).next();
    release();

    expect(asked).toEqual(["git push --force origin main"]);
    expect(step.done).toBe(true);
    expect((step.value as { allow: boolean }).allow).toBe(false);
});

test("an unattended policy refuses an ask instead of parking a card nobody will answer", async () => {
    const { gate, release } = vendorTurnGate(
        request({
            policy: { unattended: true, rulebook: "approval" },
            judge: async () => ({ decision: "ask", sentence: "Discards whatever commits origin has." }),
        }),
    );
    const step = await gate.consult("git push --force origin main", SUBJECT).next();
    release();

    expect(step.done).toBe(true);
    expect((step.value as { reason: string }).reason).toContain("This turn is running unattended: there is nobody to approve it.");
});
