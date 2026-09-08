import { expect, test } from "vitest";
import { bindingWindow, gatesModel, gatingWindows, scopedWindow } from "./plan-pools.js";
import type { AccountUsage, UsageWindow } from "../schemas/plan-limits.js";

// One rule for which pool blocks a given model, shared by the daemon and the browser: a plan can meter models
// separately, so the account's fullest pool need not be the model's own.

const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({ utilization: 10, gates: "all", ...over });
const usage = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 0 });

const GOOGLE = usage(
    window({ kind: "google:gemini-weekly", label: "Gemini models", utilization: 100, gates: { models: ["gemini"] } }),
    window({ kind: "google:3p-weekly", label: "Claude and GPT models", utilization: 27, gates: { models: ["claude", "gpt"] } }),
);

const CLAUDE = usage(
    window({ kind: "five_hour", utilization: 12 }),
    window({ kind: "seven_day", utilization: 30 }),
    window({ kind: "model:Opus", label: "Opus", utilization: 100, gates: { models: ["Opus"] } }),
    window({ kind: "surface:Cowork", label: "Cowork", utilization: 99, gates: "none" }),
);

test("matches a pool's names as runs of whole words against the id and the label alike", () => {
    expect(gatesModel({ models: ["opus"] }, { id: "claude-opus-4-6" })).toBe(true);
    expect(gatesModel({ models: ["Opus"] }, { id: "some-id", label: "Claude Opus 4.6" })).toBe(true);
    expect(gatesModel({ models: ["son"] }, { id: "claude-sonnet-4-6" })).toBe(false);
    expect(gatesModel({ models: ["claude opus"] }, { id: "claude-opus-4-6" })).toBe(true);
    expect(gatesModel({ models: ["opus claude"] }, { id: "claude-opus-4-6" })).toBe(false);
    expect(gatesModel("all", { id: "anything" })).toBe(true);
    expect(gatesModel("none", { id: "anything" })).toBe(false);
});

test("a Google account spent for Gemini still has room for Claude Opus, and the other way round", () => {
    // One account, two independently metered pools (Gemini vs Claude/GPT), each on its own clock.
    expect(bindingWindow(GOOGLE, { id: "claude-opus-4-6-thinking" })?.kind).toBe("google:3p-weekly");
    expect(bindingWindow(GOOGLE, { id: "gpt-oss-120b" })?.kind).toBe("google:3p-weekly");
    expect(bindingWindow(GOOGLE, { id: "gemini-3-pro" })?.kind).toBe("google:gemini-weekly");
    // A model family with no published pool is unmeasured, not blocked.
    expect(bindingWindow(GOOGLE, { id: "kimi-k2" })).toBeUndefined();
});

test("a Claude account's spent Opus slice does not bind a Haiku call, and its own 5-hour and weekly pools do", () => {
    expect(gatingWindows(CLAUDE, { id: "claude-haiku-4-5" }).map((entry) => entry.kind)).toEqual(["five_hour", "seven_day"]);
    expect(bindingWindow(CLAUDE, { id: "claude-haiku-4-5" })?.kind).toBe("seven_day");
    expect(bindingWindow(CLAUDE, { id: "claude-opus-4-6" })?.kind).toBe("model:Opus");
});

test("with no model named, the account's tightest pool is the answer, and a pool gating nothing is never it", () => {
    expect(bindingWindow(CLAUDE)?.kind).toBe("model:Opus");
    expect(gatingWindows(CLAUDE).map((entry) => entry.kind)).toEqual(["five_hour", "seven_day", "model:Opus"]);
    expect(bindingWindow(undefined)).toBeUndefined();
    expect(bindingWindow(usage())).toBeUndefined();
});

test("names the pool a plan meters this model by on its own, preferring the more specific and refusing a tie", () => {
    expect(scopedWindow(CLAUDE, { id: "claude-opus-4-6" })?.kind).toBe("model:Opus");
    // five_hour and seven_day meter all models, not just this one; scopedWindow needs a model-specific pool.
    expect(scopedWindow(CLAUDE, { id: "claude-haiku-4-5" })).toBeUndefined();
    const layered = usage(
        window({ kind: "model:Opus", gates: { models: ["Opus"] } }),
        window({ kind: "model:Claude Opus", gates: { models: ["Claude Opus"] } }),
    );
    expect(scopedWindow(layered, { id: "claude-opus-4-6" })?.kind).toBe("model:Claude Opus");
    const tied = usage(window({ kind: "model:Opus", gates: { models: ["Opus"] } }), window({ kind: "model:Claude", gates: { models: ["Claude"] } }));
    expect(scopedWindow(tied, { id: "claude-opus-4-6" })).toBeUndefined();
});
