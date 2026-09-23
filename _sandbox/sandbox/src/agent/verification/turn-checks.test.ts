import type { Rule } from "@intentic/sandbox-contract";
import { memoryFleet } from "../../testing.js";
import { checkRunOf, landingOutcome } from "./turn-checks.js";

const CHECK: Rule = {
    id: "pre-land",
    label: "Verify before you finish",
    moment: "turn.ending",
    action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 },
    enabled: true,
};

// The verdict travels as a conversation event and is taken by one: the Stop records, the land takes.
const record = (conversations: ReturnType<typeof memoryFleet>["conversations"], conversationId: string, rule: Rule, status: "passed" | "failed") =>
    conversations.send(conversationId, { kind: "check-ran", check: checkRunOf(rule, { status, output: "" }) }, 7);

test(`the last run wins, and a take clears it: a repaired check is a turn that passed`, () => {
    const { conversations } = memoryFleet();
    record(conversations, "c1", CHECK, "failed");
    record(conversations, "c1", CHECK, "passed");
    expect(conversations.send("c1", { kind: "verdict-taken" }).reply).toStrictEqual({
        ruleId: "pre-land",
        label: "Verify before you finish",
        command: "pnpm verify",
        status: "passed",
        at: 7,
    });
    expect(conversations.send("c1", { kind: "verdict-taken" }).reply).toBeUndefined();
});

test(`conversations do not share a verdict`, () => {
    const { conversations } = memoryFleet();
    record(conversations, "c2", CHECK, "failed");
    expect(conversations.send("c3", { kind: "verdict-taken" }).reply).toBeUndefined();
    expect(conversations.send("c2", { kind: "verdict-taken" }).reply?.status).toBe("failed");
});

test(`only a command rule records anything`, () => {
    const { conversations } = memoryFleet();
    record(conversations, "c4", { ...CHECK, action: { kind: "builtin", name: "verify-ui-edits" } }, "failed");
    expect(conversations.send("c4", { kind: "verdict-taken" }).reply).toBeUndefined();
});

test(`a run names its command only when its rule is one`, () => {
    expect(checkRunOf(CHECK, { status: "error", output: "" })).toStrictEqual({
        ruleId: "pre-land",
        label: "Verify before you finish",
        command: "pnpm verify",
        status: "error",
    });
    expect(checkRunOf({ ...CHECK, action: { kind: "builtin", name: "verify-ui-edits" } }, { status: "failed", output: "" })).toStrictEqual({
        ruleId: "pre-land",
        label: "Verify before you finish",
        status: "failed",
    });
});

test(`only a settled failure holds the land; a run that measured nothing reads as clean`, () => {
    const at = 0;
    const verdict = (status: "passed" | "failed" | "error" | "cancelled") => ({ ruleId: "x", label: "x", command: "x", status, at });
    expect(landingOutcome(undefined)).toBe("clean");
    expect(landingOutcome(verdict("passed"))).toBe("clean");
    expect(landingOutcome(verdict("error"))).toBe("clean");
    expect(landingOutcome(verdict("cancelled"))).toBe("clean");
    expect(landingOutcome(verdict("failed"))).toBe("checks-failed");
});
