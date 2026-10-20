import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { StepContext } from "../store/evolution/state-steps.js";
import { refusalLedgerStep } from "./refusal-ledger-step.js";

// The two copies a refusal used to be filed in beside the ledger (a routed model's bench, a plan-less account's run-outs
// and hand marks) are folded into the one ledger as the refusals they stood for, so nothing a person or a turn filed
// before the update is lost by it, and both files go.

const HISTORY = HISTORY_ROOT;
const at = (name: string): string => join(HISTORY, name);

const contextOver = (files: Record<string, unknown>): StepContext => ({
    roots: { workspace: WORKSPACE_ROOT, history: HISTORY, auth: join(HISTORY, "auth") },
    read: async (path) => (path in files ? JSON.stringify(files[path]) : undefined),
    list: async () => [],
    kind: async (path) => (path in files ? "file" : undefined),
});

test("files a bench and a run-out, a hand mark and an account refused outright, as the refusals they stood for", async () => {
    const plan = await refusalLedgerStep.plan(
        contextOver({
            [at("model-cooldowns.json")]: { "codex:gpt-6.1-sol": { until: 1_900_000_000_000, message: "try again at 1:53 PM", since: 1_800_000_000_000 } },
            [at("observed-limits.json")]: {
                "cursor:one": {
                    "composer-2.5": { at: 1_800_000_000_000, message: "Marked out of allowance by hand.", byHand: true },
                    "*": { at: 1_800_000_000_001, message: "[role_forbidden]", refused: "entitlement" },
                },
            },
            [at("account-usage.json")]: {
                one: { measuredAt: 1, windows: [{ kind: "observed:composer-2.5", utilization: 100, gates: { models: ["composer-2.5"] } }] },
                claude1: { measuredAt: 1, windows: [{ kind: "five_hour", utilization: 10, gates: "all" }] },
            },
        }),
    );
    expect(plan?.writes.get(at("model-cooldowns.json"))).toBeUndefined();
    expect(plan?.writes.has(at("model-cooldowns.json"))).toBe(true);
    expect(plan?.writes.has(at("observed-limits.json"))).toBe(true);
    const ledger = JSON.parse(plan?.writes.get(at("provider-refusals.json")) ?? "{}");
    expect(Object.values(ledger)).toEqual(
        expect.arrayContaining([
            { at: 1_800_000_000_000, kind: "limit", message: "try again at 1:53 PM", model: "gpt-6.1-sol", resetsAt: 1_900_000_000 },
            { at: 1_800_000_000_000, kind: "limit", message: "Marked out of allowance by hand.", account: "one", model: "composer-2.5", byHand: true },
            { at: 1_800_000_000_001, kind: "entitlement", message: "[role_forbidden]", account: "one" },
        ]),
    );
    // The projection of the run-outs into readings goes, and every other reading stays as it was.
    expect(JSON.parse(plan?.writes.get(at("account-usage.json")) ?? "{}")).toEqual({
        claude1: { measuredAt: 1, windows: [{ kind: "five_hour", utilization: 10, gates: "all" }] },
    });
});

test("keeps what the ledger already holds over either retired copy, and settles once nothing is left to fold", async () => {
    const newer = { at: 1_850_000_000_000, kind: "limit", message: "newer", model: "gpt-6.1-sol" };
    const plan = await refusalLedgerStep.plan(
        contextOver({
            [at("model-cooldowns.json")]: { "codex:gpt-6.1-sol": { until: 1_900_000_000_000, message: "older" } },
            [at("provider-refusals.json")]: { "codex:limit::gpt-6.1-sol": newer },
        }),
    );
    expect(JSON.parse(plan?.writes.get(at("provider-refusals.json")) ?? "{}")).toEqual({ "codex:limit::gpt-6.1-sol": newer });
    expect(await refusalLedgerStep.plan(contextOver({ [at("provider-refusals.json")]: { "codex:limit::gpt-6.1-sol": newer } }))).toBeUndefined();
});
