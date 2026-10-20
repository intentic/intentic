import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { providerRefusals, translatorAccounts } from "./providerAccounts";
import { openingPin } from "./roleModel";

// The job's button names the rung its run opens on: the daemon steps a rung no connected account can serve over
// (run-role-model.ts, contract openingRung over fleetCapacity), and this window judges the same rung by the same
// verdict over its own account rows and refusals. 2026-10-20: it took the head of the chain by readiness alone, and
// named a spent Codex model while the run opened on the Claude one after it (sessions crisp-ivy, witty-pebble).

const SOL: ModelPin = { provider: `codex`, model: `gpt-6.1-sol` };
const OPUS: ModelPin = { provider: `claude`, model: `claude-opus-4-6` };
const until = Math.ceil(Date.now() / 1000) + 3_600;
const reading: AccountUsage = { measuredAt: 2_000, windows: [{ kind: `five_hour`, utilization: 0, gates: `all`, resetsAt: until + 7_200 }] };
const empty = { codex: [], grok: [], kimi: [], gemini: [] };

afterEach(() => {
    translatorAccounts.value = empty;
    providerRefusals.value = {};
});

describe(`openingPin`, () => {
    beforeEach(() => {
        translatorAccounts.value = { ...empty, codex: [{ name: `team.json`, label: `team`, usage: reading }] };
        providerRefusals.value = { codex: [{ at: 1_000, kind: `limit`, message: `try again later`, model: SOL.model, resetsAt: until }] };
    });

    it(`steps over a rung every account is spent on, as the run does`, () => {
        expect(openingPin([SOL, OPUS], Date.now())).toBe(OPUS);
    });

    it(`comes back to it at the instant the refusal said, not at a later reading`, () => {
        expect(openingPin([SOL, OPUS], until * 1000 - 1)).toBe(OPUS);
        expect(openingPin([SOL, OPUS], until * 1000)).toBe(SOL);
    });

    it(`opens on the head when every rung is spent, since the readings may already be stale`, () => {
        expect(openingPin([SOL], Date.now())).toBe(SOL);
        expect(openingPin([], Date.now())).toBeUndefined();
    });
});
