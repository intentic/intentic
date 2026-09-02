import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fleetLimit } from "./fleet-limit.js";

/* ONE RULE FOR "IS THIS FLEET SPENT FOR THIS MODEL". What is pinned is the scoping the six rules it replaced
 * disagreed on: an account counts on the pools the model spends, a spent pool for another family is not a
 * spent account, the proxy's own bench outranks any reading, and the three states (spent, room, nothing on
 * file) stay apart. */

const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({ utilization: 10, gates: "all", ...over });
const reading = (account: string, ...windows: UsageWindow[]): { account: string; usage: AccountUsage } => ({
    account,
    usage: { windows, measuredAt: 1_000 },
});

const GEMINI: Pick<UsageWindow, "kind" | "label" | "gates"> = { kind: "google:gemini-weekly", label: "Gemini models", gates: { models: ["gemini"] } };
const THIRD_PARTY: Pick<UsageWindow, "kind" | "label" | "gates"> = {
    kind: "google:3p-weekly",
    label: "Claude and GPT models",
    gates: { models: ["claude", "gpt"] },
};

test("counts an account on the pools the model spends, and names the pool that is out", () => {
    const fleet = [
        reading("a", window({ ...GEMINI, utilization: 100, resetsAt: 2_000 }), window({ ...THIRD_PARTY, utilization: 73, resetsAt: 9_000 })),
        reading("b", window({ ...GEMINI, utilization: 100, resetsAt: 3_000 }), window({ ...THIRD_PARTY, utilization: 100, resetsAt: 5_000 })),
    ];
    // Gemini: both spent, the earliest reset answers, and the pool is named in the provider's words.
    expect(fleetLimit(fleet, { id: "gemini-3-pro" })).toEqual({ pool: "Gemini models", spent: 2, withHeadroom: 0, reopensAt: 2_000 });
    // Claude Opus on the same accounts: one still has room in the pool it spends, so no reset is named.
    expect(fleetLimit(fleet, { id: "claude-opus-4-6-thinking" })).toEqual({ pool: "Claude and GPT models", spent: 1, withHeadroom: 1, roomMeasuredAt: 1_000 });
    // A family neither pool gates is nothing on file.
    expect(fleetLimit(fleet, { id: "kimi-k2" })).toEqual({ spent: 0, withHeadroom: 0 });
});

test("an undivided plan gates every model on every window, and has no pool to name", () => {
    const fleet = [reading("one", window({ kind: "five_hour", utilization: 100, resetsAt: 1_000 }), window({ kind: "seven_day", utilization: 12, resetsAt: 8_000 }))];
    expect(fleetLimit(fleet, { id: "gpt-5" })).toEqual({ spent: 1, withHeadroom: 0, reopensAt: 1_000 });
});

test("a Claude account's spent Opus slice does not count against a Haiku call", () => {
    const fleet = [reading("a", window({ kind: "seven_day", utilization: 30 }), window({ kind: "model:Opus", label: "Opus", utilization: 100, resetsAt: 4_000, gates: { models: ["Opus"] } }))];
    expect(fleetLimit(fleet, { id: "claude-haiku-4-5" })).toEqual({ spent: 0, withHeadroom: 1, roomMeasuredAt: 1_000 });
    expect(fleetLimit(fleet, { id: "claude-opus-4-6" })).toEqual({ pool: "Opus", spent: 1, withHeadroom: 0, reopensAt: 4_000 });
});

test("the translator's bench of a credential is spent whatever its reading says, with the proxy's retry instant", () => {
    const fleet = [
        { ...reading("benched", window({ kind: "seven_day", utilization: 5 })), cooling: { until: 700, reason: "quota exceeded" } },
        { ...reading("never-read"), usage: undefined },
    ];
    expect(fleetLimit(fleet, { id: "kimi-k2" })).toEqual({ spent: 1, withHeadroom: 0, reopensAt: 700 });
});

test("with no model named, every pool that gates anything counts and one gating nothing never does", () => {
    const fleet = [reading("a", window({ kind: "seven_day", utilization: 20 }), window({ kind: "code-review:five_hour", utilization: 100, gates: "none" }))];
    expect(fleetLimit(fleet, undefined)).toEqual({ spent: 0, withHeadroom: 1, roomMeasuredAt: 1_000 });
});
