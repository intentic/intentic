import "@intentic/testing/dom";
import { effectScope, ref } from "vue";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// The card's two presses for a stranded turn reach the daemon through useAgents, stubbed to see which one went.
const setBreakPolicy = jest.fn(async () => {});
const resumeHeldTurn = jest.fn(async () => {});
const notice = ref<string | undefined>();
jest.mock("../../../../models/fleet/useAgents", () => ({
    useAgents: () => ({ setBreakPolicy, resumeHeldTurn, refresh: async () => {}, notice }),
}));

const { useCardRequests } = await import("./cardRequests");

afterEach(() => {
    setBreakPolicy.mockClear();
    resumeHeldTurn.mockClear();
});

// SAFETY: useCardRequests reads only the id and the limit fields of a card; the rest of a FleetAgent goes unread here.
const stranded = (resetInSeconds: number | undefined): FleetAgent =>
    ({
        id: `a1`,
        status: `error`,
        failureCode: `rate_limit`,
        limitHeld: true,
        limitResetsAt: resetInSeconds === undefined ? undefined : Math.floor(Date.now() / 1000) + resetInSeconds,
    }) as FleetAgent;

const pressFor = async (agent: FleetAgent) => {
    const scope = effectScope();
    const requests = scope.run(() => useCardRequests(() => agent, () => `t`, () => true))!;
    const atReset = requests.atReset.value;
    await requests.resend();
    scope.stop();
    return atReset;
};

// A re-run into a window still shut is only refused again: the press books it for the reset, as the chat's answer does.
it(`books the resend for the reset while the allowance is still spent`, async () => {
    expect(await pressFor(stranded(40 * 60))).toBe(true);
    expect(setBreakPolicy).toHaveBeenCalledWith(`a1`, `limit`, `resend`);
    expect(resumeHeldTurn).not.toHaveBeenCalled();
});

it(`sends the held turn now once the window is open or no reset is known`, async () => {
    for (const agent of [stranded(-60), stranded(undefined)]) {
        expect(await pressFor(agent)).toBe(false);
    }
    expect(resumeHeldTurn).toHaveBeenCalledTimes(2);
    expect(setBreakPolicy).not.toHaveBeenCalled();
});
