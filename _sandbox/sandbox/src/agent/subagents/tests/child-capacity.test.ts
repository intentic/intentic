import { failedOnCapacity } from "../child-spec.js";
import type { ChildTurnTally } from "../children.js";

// 2026-11-17, the shinobi-society audit: a child whose runner's workspace prep failed was named in "Capacity is back"
// notices as if an account coming back could help it.
const ended = (code: string | undefined, errored = true): ChildTurnTally => ({
    bubble: "",
    report: "",
    toolUses: 0,
    tokens: 0,
    failure: "it failed",
    rerun: undefined,
    answered: false,
    code,
    substituted: false,
    errored,
    carriesBrief: false,
    ceiling: false,
});

describe("failedOnCapacity", () => {
    it("is true for a spent allowance, a rate limit, a trial's day and an outage", () => {
        expect(["rate_limit", "trial-exhausted", "provider-outage"].map((code) => failedOnCapacity(ended(code)))).toEqual([true, true, true]);
    });

    it("is false for the sandbox's own walls, a refused account, an uncoded failure and a turn that did not error", () => {
        expect(["workspace-setup", "claude-not-entitled", "turn-cap"].map((code) => failedOnCapacity(ended(code)))).toEqual([false, false, false]);
        expect(failedOnCapacity(ended(undefined))).toBe(false);
        expect(failedOnCapacity(ended("rate_limit", false))).toBe(false);
    });
});
