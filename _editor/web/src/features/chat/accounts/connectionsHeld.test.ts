// jsdom: the import chain reaches app-wide singletons that read browser globals (window.env) as they load.
import "@intentic/testing/dom";
import { type PlanLimitsHeld, type PlanLimitsRefreshed, type TrialStatusResponse, TrialStatusSchema } from "@intentic/sandbox-contract";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// What a connection read learns about accounts the provider is holding reads off. A press was the only thing that ever
// asked, so a frozen number explained itself only to whoever pressed the control it had already stopped answering —
// and on arrival, the surface most likely to be read, the one line that says why said nothing at all.

const NO_TRIAL = TrialStatusSchema.parse({ available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` });

// Every connection read answers empty; the plan-limits re-measure and the trial allowance are the two a test holds.
const refreshPlanLimits = jest.fn<(input: { force?: boolean }) => Promise<PlanLimitsRefreshed>>();
const trial = jest.fn(async (): Promise<TrialStatusResponse> => NO_TRIAL);
jest.mock("../../sandbox/client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        usage: { refreshPlanLimits },
        accounts: { accounts: async () => ({ accounts: [] }) },
        translator: { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) },
        agent: { refusals: async () => ({ refusals: {} }) },
        providers: { list: async () => ({ native: [], agents: [], endpoints: [] }) },
        endpoints: { trial },
    }),
}));

interface Posted {
    readonly procedure: string;
    readonly force: unknown;
}

// Records what the plan-limits re-measure was asked for; `held` is what it answers with, undefined for a daemon that is
// gone.
const daemon = (held: PlanLimitsHeld[] | undefined, posted: Posted[] = []): Posted[] => {
    refreshPlanLimits.mockReset();
    refreshPlanLimits.mockImplementation(async ({ force }) => {
        posted.push({ procedure: `usage.refreshPlanLimits`, force });
        if (held === undefined) {
            throw new Error(`daemon is unreachable`);
        }
        return { ok: true, held };
    });
    return posted;
};

const { heldAccounts, refreshConnections } = await import("./useChat-accounts");
const { accountsLoaded } = await import("./providerAccounts");

const HELD = [{ provider: `claude`, account: `a`, resumesAt: 1_800_000_000 }];

// The arrival read holds for the daemon's sweep by design, and the trial read waits on the platform; neither is an
// account list, so the capacity rail's skeleton and every "checking" chip must not wait on them.
it(`opens the account gate on the lists while the plan-limits hold and the trial read are still out`, async () => {
    const measured = Promise.withResolvers<PlanLimitsRefreshed>();
    const allowance = Promise.withResolvers<TrialStatusResponse>();
    refreshPlanLimits.mockReturnValue(measured.promise);
    trial.mockReturnValueOnce(allowance.promise);
    accountsLoaded.value = false;
    let settled = false;
    const connections = refreshConnections().then(() => {
        settled = true;
    });

    try {
        // One macrotask: every read that answered has had its microtasks run, and the held two have not answered.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(accountsLoaded.value).toBe(true);
        expect(settled).toBe(false);
    } finally {
        // Released either way: a read left in flight would be joined by the next test's refreshConnections.
        measured.resolve({ ok: true, held: [] });
        allowance.resolve(NO_TRIAL);
        await connections;
    }
    expect(settled).toBe(true);
});

it(`learns what is held on arrival, not only from a press`, async () => {
    const posted = daemon(HELD);
    heldAccounts.value = [];

    await refreshConnections();
    // Unforced: the sweep it triggers is held to every target's own read budget, so arriving at a screen cannot
    // itself spend the endpoint budget the number depends on.
    expect(posted).toEqual([{ procedure: `usage.refreshPlanLimits`, force: false }]);
    expect(heldAccounts.value).toEqual(HELD);
});

it(`asks to measure again when a press says so, and takes the answer over the one it had`, async () => {
    const posted = daemon([]);
    heldAccounts.value = HELD;

    await refreshConnections(true);
    expect(posted).toEqual([{ procedure: `usage.refreshPlanLimits`, force: true }]);
    // A press that read everything says so by answering with nothing held; the note has to come down.
    expect(heldAccounts.value).toEqual([]);
});

it(`keeps what it last knew when the daemon does not answer, since silence withdraws nothing`, async () => {
    daemon(undefined);
    heldAccounts.value = HELD;

    await refreshConnections(true);
    expect(heldAccounts.value).toEqual(HELD);
});
