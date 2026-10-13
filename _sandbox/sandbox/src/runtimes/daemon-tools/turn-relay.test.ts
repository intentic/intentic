import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CommandGuard, GuardOutcome } from "../../guard/command-guard.js";
import { createTurnTaint } from "../../guard/turn-taint.js";
import { turnWatchdog } from "../decorators/turn-watchdog.js";
import { createTurnRelay, UNGATED } from "./turn-relay.js";

// The late binding between a daemon tool planned with the turn and the loop that runs it: frames, holds and marks made
// before the loop attaches wait for it, and nothing a tool asks of the gate runs before there is one.

const frame = (text: string): AgentEvent => ({ kind: "delta", text });

// A gate that raises one card frame and answers as told.
const gateAnswering = (outcome: GuardOutcome): CommandGuard => ({
    enforcing: true,
    async *consult() {
        yield frame("card");
        return outcome;
    },
});

test("frames pushed before the loop attaches are delivered in order on attach, then straight through", () => {
    const relay = createTurnRelay();
    relay.push(frame("a"));
    relay.push(frame("b"));
    const seen: AgentEvent[] = [];
    const detach = relay.attach({ push: (event) => seen.push(event) });
    relay.push(frame("c"));
    expect(seen).toEqual([frame("a"), frame("b"), frame("c")]);
    detach();
    relay.push(frame("d"));
    expect(seen).toHaveLength(3);
});

test("a hold taken before the watchdog attaches is taken on it at attach, and released with the tool's release", () => {
    const relay = createTurnRelay();
    const clock = turnWatchdog({ inactivityMs: 10, maxTurnMs: 20 });
    const release = relay.hold();
    expect(clock.remaining()).toBeLessThan(Number.POSITIVE_INFINITY);
    relay.attach({ hold: clock.hold });
    // Held: no deadline runs while a card waits on a person.
    expect(clock.remaining()).toBe(Number.POSITIVE_INFINITY);
    release();
    release();
    expect(clock.remaining()).toBeLessThan(Number.POSITIVE_INFINITY);
});

test("a hold taken after attach holds the watchdog until released; a detached loop's holds are let go", () => {
    const relay = createTurnRelay();
    const clock = turnWatchdog({ inactivityMs: 10, maxTurnMs: 20 });
    const detach = relay.attach({ hold: clock.hold });
    relay.hold();
    expect(clock.remaining()).toBe(Number.POSITIVE_INFINITY);
    detach();
    expect(clock.remaining()).toBeLessThan(Number.POSITIVE_INFINITY);
});

test("marks made before the gate attaches reach its taint bit, first source first", () => {
    const relay = createTurnRelay();
    relay.mark("diagnostics");
    relay.mark("web");
    const taint = createTurnTaint();
    relay.attach({ guard: { gate: gateAnswering({ allow: true }), taint } });
    expect(taint.source()).toBe("diagnostics");
    relay.mark("later");
    expect(taint.source()).toBe("diagnostics");
});

test("a consult with no gate attached refuses; with one, its frames reach the stream and the watchdog is held throughout", async () => {
    const relay = createTurnRelay();
    expect(await relay.consult("rm -rf build", { toolName: "Bash", displayName: "Run command", noun: "command", language: "bash" })).toEqual({
        allow: false,
        reason: UNGATED,
    });
    const seen: AgentEvent[] = [];
    const clock = turnWatchdog({ inactivityMs: 10, maxTurnMs: 20 });
    let heldDuring = false;
    const gate: CommandGuard = {
        enforcing: true,
        async *consult() {
            heldDuring = clock.remaining() === Number.POSITIVE_INFINITY;
            yield frame("card");
            return { allow: false, reason: "no" };
        },
    };
    relay.attach({ push: (event) => seen.push(event), hold: clock.hold, guard: { gate, taint: createTurnTaint() } });
    expect(await relay.consult("rm -rf build", { toolName: "Bash", displayName: "Run command", noun: "command", language: "bash" })).toEqual({
        allow: false,
        reason: "no",
    });
    expect(heldDuring).toBe(true);
    expect(seen).toEqual([frame("card")]);
    expect(clock.remaining()).toBeLessThan(Number.POSITIVE_INFINITY);
});
