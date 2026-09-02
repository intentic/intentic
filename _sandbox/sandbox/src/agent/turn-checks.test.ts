import type { Rule } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { landingOutcome, recordCheckVerdict, takeCheckVerdict } from "./turn-checks.js";

const CHECK: Rule = {
    id: "pre-land",
    label: "Verify before you finish",
    moment: "turn.ending",
    action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 },
    enabled: true,
};

test(`the last run wins, and a take clears it: a repaired check is a turn that passed`, () => {
    recordCheckVerdict("c1", CHECK, { status: "failed", exitCode: 1, output: "1 failed" });
    recordCheckVerdict("c1", CHECK, { status: "passed", exitCode: 0, output: "" });
    expect(takeCheckVerdict("c1")).toMatchObject({ ruleId: "pre-land", label: "Verify before you finish", command: "pnpm verify", status: "passed" });
    expect(takeCheckVerdict("c1")).toBeUndefined();
});

test(`conversations do not share a verdict`, () => {
    recordCheckVerdict("c2", CHECK, { status: "failed", exitCode: 1, output: "" });
    expect(takeCheckVerdict("c3")).toBeUndefined();
    expect(takeCheckVerdict("c2")?.status).toBe("failed");
});

test(`only a command rule records anything`, () => {
    recordCheckVerdict("c4", { ...CHECK, action: { kind: "instruct", text: "say hi" } }, { status: "failed", output: "" });
    expect(takeCheckVerdict("c4")).toBeUndefined();
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
