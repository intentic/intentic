import { expect, test } from "vitest";
import { vendorSubject } from "./command-gate.js";
import { createTurnGate, type TurnGateInput, turnIsGated } from "./turn-gate.js";
import { conversationTainted } from "./turn-taint.js";

// Built by the production helper rather than spelled out, so this file isn't a second opinion on its shape.
const SUBJECT = vendorSubject("bash");

const turn = (overrides: Partial<Parameters<typeof createTurnGate>[0]> = {}): Parameters<typeof createTurnGate>[0] => ({
    signal: new AbortController().signal,
    ...overrides,
});

// Stub judges; this file tests the shape a declaration produces, not the model, so the verdict is fixed.
const ASKS: TurnGateInput["judge"] = async () => ({ decision: "ask", sentence: "Discards whatever commits origin has." });
const REFUSES: TurnGateInput["judge"] = async () => ({ decision: "refuse", sentence: "Your policy forbids this." });

test("a vendor turn a stranger woke reads tainted from outside the generator", () => {
    const { release } = createTurnGate(turn({ conversationId: "c1", outsideWake: "discord" }));
    expect(conversationTainted("c1")).toBe(true);
    release();
    expect(conversationTainted("c1")).toBe(false);
});

test("an ordinary turn is not tainted, and an unknown conversation answers false", () => {
    const { release } = createTurnGate(turn({ conversationId: "c2" }));
    expect(conversationTainted("c2")).toBe(false);
    expect(conversationTainted("never-ran")).toBe(false);
    release();
});

test('a runtime declaring rulebook "none" reads tainted for its whole life, and says why', () => {
    const { taint, release } = createTurnGate(turn({ conversationId: "c3", rulebook: "none" }));
    expect(conversationTainted("c3")).toBe(true);
    expect(taint.source()).toContain("no command gate");
    release();
});

test("a gate-less runtime woken by a stranger names the stranger", () => {
    const { taint, release } = createTurnGate(turn({ conversationId: "c4", outsideWake: "webchat", rulebook: "none" }));
    expect(taint.source()).toBe("webchat");
    release();
});

test("a turn with no conversation publishes nothing", () => {
    const { gate, release } = createTurnGate(turn({ outsideWake: "discord" }));
    expect(gate.enforcing).toBe(true);
    release();
});

test("turnIsGated agrees with the gate it predicts", () => {
    for (const input of [
        turn(),
        turn({ safetyPolicy: `` }),
        turn({ safetyPolicy: `Ask before force-pushing.` }),
        turn({ outsideWake: "discord" }),
        turn({ safetyPolicy: `Never delete anything.`, outsideWake: "webchat" }),
    ]) {
        const { gate, release } = createTurnGate(input);
        expect(turnIsGated(), JSON.stringify({ policy: input.safetyPolicy, wake: input.outsideWake })).toBe(gate.enforcing);
        release();
    }
});

test("a workspace with no policy at all is still gated", () => {
    const { gate, release } = createTurnGate(turn());
    expect(gate.enforcing).toBe(true);
    release();
});

test('a runtime declaring "refuse-only" refuses an ask, without claiming nobody is watching', async () => {
    const { gate, release } = createTurnGate(turn({ judge: ASKS, rulebook: "refuse-only" }));
    const consulting = gate.consult("git push --force origin main", SUBJECT);
    const step = await consulting.next();
    expect(step.done).toBe(true);
    const outcome = step.value as { allow: boolean; reason: string };
    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toContain("cannot pause to ask");
    expect(outcome.reason).not.toContain("nobody to approve");
    release();
});

test('a refusal is enforced in full on a "refuse-only" runtime', async () => {
    const { gate, release } = createTurnGate(turn({ judge: REFUSES, rulebook: "refuse-only" }));
    const step = await gate.consult("git push --force origin main", SUBJECT).next();
    expect(step.done).toBe(true);
    expect((step.value as { allow: boolean }).allow).toBe(false);
    release();
});

test("every rulebook value produces its own shape, from the declaration alone", async () => {
    const shapeOf = async (rulebook: TurnGateInput["rulebook"]) => {
        // Spread only when set; exactOptionalPropertyTypes treats explicit undefined as different from absent.
        const { gate, taint, release } = createTurnGate(turn({ judge: ASKS, ...(rulebook === undefined ? {} : { rulebook }) }));
        const step = await gate.consult("git push --force origin main", SUBJECT).next();
        release();
        // Parks: yielded a card first; refuses: returned immediately without one.
        return { parks: step.done !== true, bornTainted: taint.tainted() };
    };

    expect(await shapeOf("hooks")).toEqual({ parks: true, bornTainted: false });
    expect(await shapeOf("approval")).toEqual({ parks: true, bornTainted: false });
    expect(await shapeOf("refuse-only")).toEqual({ parks: false, bornTainted: false });
    expect(await shapeOf("none")).toEqual({ parks: false, bornTainted: true });
    expect(await shapeOf(undefined)).toEqual({ parks: true, bornTainted: false });
});
