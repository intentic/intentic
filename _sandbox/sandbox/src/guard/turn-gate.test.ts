import { expect, test } from "vitest";
import { vendorSubject } from "./command-gate.js";
import { createTurnGate, type TurnGateInput, turnIsGated } from "./turn-gate.js";
import { conversationTainted } from "./turn-taint.js";

// What a vendor runtime hands the gate, built by the production helper rather than spelled out three times:
// every field of a subject (which grammar colours its card, what its title calls it) is the helper's answer,
// and a literal here would be this file's second opinion about it.
const SUBJECT = vendorSubject("bash");

const turn = (overrides: Partial<Parameters<typeof createTurnGate>[0]> = {}): Parameters<typeof createTurnGate>[0] => ({
    signal: new AbortController().signal,
    ...overrides,
});

/* THE WALLET'S BUG, AS A TEST. `conversationTainted` is read from the daemon's HTTP layer, outside any turn
 * generator, and it used to answer `false` for five of the six runtimes because only the Claude Code loop
 * published a bit. A turn a stranger woke therefore kept the owner's standing auto-approve band on Codex, Grok,
 * Gemini, Pi and ACP, which is the one grant that band was never meant to cover. */
test("a vendor turn a stranger woke reads tainted from outside the generator", () => {
    const { release } = createTurnGate(turn({ conversationId: "c1", outsideWake: "discord" }));
    expect(conversationTainted("c1")).toBe(true);
    release();
    // The bit dies with the turn: the next one starts clean unless it too takes something in.
    expect(conversationTainted("c1")).toBe(false);
});

test("an ordinary turn is not tainted, and an unknown conversation answers false", () => {
    const { release } = createTurnGate(turn({ conversationId: "c2" }));
    expect(conversationTainted("c2")).toBe(false);
    expect(conversationTainted("never-ran")).toBe(false);
    release();
});

/* Pi has no consult seam at all, so there is no later moment where the bit could be acted on. Treating such a
 * turn as permanently carrying outside content is the safe direction of that ambiguity: the wallet asks in chat
 * instead of spending inside a delegation that assumed a gate existed. */
test('a runtime declaring rulebook "none" reads tainted for its whole life, and says why', () => {
    const { taint, release } = createTurnGate(turn({ conversationId: "c3", rulebook: "none" }));
    expect(conversationTainted("c3")).toBe(true);
    expect(taint.source()).toContain("no command gate");
    release();
});

// The wake's own source wins over the blind stand-in: naming the stranger is more useful on a card than naming
// the runtime, and the first source is the one that could have planted an instruction.
test("a gate-less runtime woken by a stranger names the stranger", () => {
    const { taint, release } = createTurnGate(turn({ conversationId: "c4", outsideWake: "webchat", rulebook: "none" }));
    expect(taint.source()).toBe("webchat");
    release();
});

// A turn with no conversation behind it (a bench run, a one-shot helper) publishes nothing rather than
// polluting the map under a key nobody will clear.
test("a turn with no conversation publishes nothing", () => {
    const { gate, release } = createTurnGate(turn({ outsideWake: "discord" }));
    // The gate still holds the bit, so the taint floor applies to the turn itself.
    expect(gate.enforcing).toBe(true);
    release();
});

/* `turnIsGated` is what a vendor runtime asks BEFORE its turn starts, to decide whether to make the vendor raise
 * approvals at all. It must agree with the gate's own `enforcing`, or a runtime would either ask for approvals
 * nothing will judge or judge nothing because it never asked.
 *
 * BOTH ARE NOW ALWAYS TRUE, including for the empty rulebook that used to answer false: the standing floor
 * (guard/actions.ts) holds the classes nothing undoes on every turn, so an unconfigured workspace is exactly
 * the one that would have gone unjudged. This test is the pair's agreement, not the value, so it still fails
 * if either side is changed alone. */
test("turnIsGated agrees with the gate it predicts", () => {
    for (const input of [
        turn(),
        turn({ commandRules: {} }),
        turn({ commandRules: { "git.destructive": "hold" } }),
        turn({ outsideWake: "discord" }),
        turn({ commandRules: { "files.destructive": "deny" }, outsideWake: "webchat" }),
    ]) {
        const { gate, release } = createTurnGate(input);
        expect(turnIsGated(), JSON.stringify({ rules: input.commandRules, wake: input.outsideWake })).toBe(gate.enforcing);
        release();
    }
});

// The floor is what makes the unconfigured workspace the interesting case: nobody wrote a rule, nothing was
// woken from outside, and a command that would format a disk still has something to answer to.
test("a workspace with no rules at all is still gated", () => {
    const { gate, release } = createTurnGate(turn());
    expect(gate.enforcing).toBe(true);
    release();
});

/* THE REFUSE-ONLY SHAPE (OpenCode). A hold cannot park there because the vendor aborts a turn that goes quiet
 * for two minutes, so it arrives as a refusal, and the wording must name the real reason rather than borrowing
 * the unattended one: telling a user sitting in front of the composer that "there is nobody to approve it"
 * would be a lie about their own turn. */
test('a runtime declaring "refuse-only" refuses a hold, without claiming nobody is watching', async () => {
    const { gate, release } = createTurnGate(turn({ commandRules: { "git.destructive": "hold" }, rulebook: "refuse-only" }));
    const consulting = gate.consult("git push --force origin main", SUBJECT);
    const step = await consulting.next();
    // No card: it never yields one, which is the whole point of the shape.
    expect(step.done).toBe(true);
    const outcome = step.value as { allow: boolean; reason: string };
    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toContain("cannot pause to ask");
    expect(outcome.reason).not.toContain("nobody to approve");
    release();
});

// A deny is unaffected: it never wanted to ask, so refuse-only costs it nothing.
test('a deny is enforced in full on a "refuse-only" runtime', async () => {
    const { gate, release } = createTurnGate(turn({ commandRules: { "git.destructive": "deny" }, rulebook: "refuse-only" }));
    const step = await gate.consult("git push --force origin main", SUBJECT).next();
    expect(step.done).toBe(true);
    expect((step.value as { allow: boolean }).allow).toBe(false);
    release();
});

/* THE DECLARATION IS THE WIRING, which is what the capability ledger classifies `rulebook` as enforced for. A
 * row that changed its mind about what it can do would change these behaviours, not just the sentence the
 * composer shows, and that is the whole difference between an axis and a label. */
test("every rulebook value produces its own shape, from the declaration alone", async () => {
    const shapeOf = async (rulebook: TurnGateInput["rulebook"]) => {
        // Spread only when set: under exactOptionalPropertyTypes an explicit `undefined` is not the same as an
        // absent key, and "absent" is the case the last assertion below is about.
        const { gate, taint, release } = createTurnGate(
            turn({ commandRules: { "git.destructive": "hold" }, ...(rulebook === undefined ? {} : { rulebook }) }),
        );
        const step = await gate.consult("git push --force origin main", SUBJECT).next();
        release();
        // A parked shape yields a card first; a refusing one returns straight away.
        return { parks: step.done !== true, bornTainted: taint.tainted() };
    };

    expect(await shapeOf("hooks")).toEqual({ parks: true, bornTainted: false });
    expect(await shapeOf("approval")).toEqual({ parks: true, bornTainted: false });
    expect(await shapeOf("refuse-only")).toEqual({ parks: false, bornTainted: false });
    expect(await shapeOf("none")).toEqual({ parks: false, bornTainted: true });
    // An absent declaration is the ceiling: the safe default for a caller that builds a request by hand.
    expect(await shapeOf(undefined)).toEqual({ parks: true, bornTainted: false });
});
