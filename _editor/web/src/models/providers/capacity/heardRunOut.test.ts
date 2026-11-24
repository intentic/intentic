import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { providerRefusals } from "../providerAccounts";
import { accountHeadroom, heardRunOut } from "./heardRunOut";

// A run-out another of the owner's sandboxes on the same account met: the meter draws it spent, as any refusal, and says
// where it was seen.

const NOW = Date.now();
const reading: AccountUsage = {
    windows: [{ kind: `five_hour`, label: `5h`, utilization: 10, gates: `all`, resetsAt: Math.floor(NOW / 1000) + 3600 }],
    measuredAt: NOW - 120_000,
};
const heard = (over: Partial<ProviderRefusal> = {}): ProviderRefusal => ({
    at: NOW - 60_000,
    kind: `limit`,
    message: `This account's allowance ran out in another sandbox signed in to it.`,
    account: `claude-1`,
    resetsAt: Math.floor(NOW / 1000) + 3600,
    source: `another-sandbox`,
    ...over,
});

describe(`a run-out heard from another sandbox`, () => {
    afterEach(() => {
        providerRefusals.value = {};
    });

    it(`draws the account spent and says another sandbox ran it out`, () => {
        providerRefusals.value = { claude: [heard()] };
        const headroom = accountHeadroom(`claude`, `claude-1`, { attached: reading });
        expect(headroom?.percent).toBe(100);
        expect(headroom?.heardRunOut).toBe(NOW - 60_000);
    });

    it(`says nothing for this sandbox's own refusal, another account's, or one past its reset`, () => {
        providerRefusals.value = {
            claude: [heard({ source: undefined }), heard({ account: `claude-2` }), heard({ resetsAt: Math.floor(NOW / 1000) - 60 })],
        };
        expect(heardRunOut(`claude`, `claude-1`)).toBeUndefined();
        expect(accountHeadroom(`claude`, `claude-1`, { attached: reading })?.heardRunOut).toBeUndefined();
    });
});
