import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync, waitFor } from "@intentic/testing/bun";
import { computed, ref } from "vue";
import { providerAccounts } from "../accounts/providerAccounts";
import type { PickUp } from "./pickUp";
import type { SessionRef } from "./turnRequest";
import { type FailureHost, TurnFailures } from "./turnFailures";

// The sandbox's account list, as a give-up or a clean turn asks it again; late imported by the module under test.
const refreshAccounts = jest.fn(async () => []);
jest.mock("../accounts/useChat-accounts", () => ({ refreshAccounts }));

// A failure host whose turn records what the failure asked of it; nothing here writes a transcript line, so that seam
// names itself if a case reaches for it.
const hostOf = (): FailureHost & { readonly reattach: ReturnType<typeof jest.fn> } => {
    const reattach = jest.fn(async () => false);
    return {
        reattach,
        transcript: unstubbed<FailureHost["transcript"]>(`transcript`, {}),
        selection: unstubbed<FailureHost["selection"]>(`selection`, {}),
        session: ref<SessionRef | undefined>(),
        error: ref<string | null>(null),
        pickUp: ref<PickUp | undefined>(),
        turn: unstubbed<FailureHost["turn"]>(`turn`, { streaming: computed(() => false), reattach }),
    };
};

describe(`a turn that outgrew the model's window`, () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    // The daemon opens the fresh session on its next pass, holding the conversation's queue for it; attach streams are
    // pull, so the window has to go looking for that run once this one's stream is over.
    it(`is a wait this window watches when the daemon re-runs it, not the error line`, async () => {
        const host = hostOf();
        const failures = new TurnFailures(host);
        host.error.value = `an earlier sentence in the same turn`;
        failures.apply({
            kind: `error`,
            code: `context-overflow`,
            message: `Prompt is too long. Resuming…`,
            autoResume: `scheduled`,
            held: { ran: true },
        });

        expect(host.error.value).toBeNull();
        expect(host.pickUp.value).toBeUndefined();
        // Nothing is probed mid-stream: the run it would find is the one still failing.
        await advanceTimersByTimeAsync(10_000);
        expect(host.reattach).toHaveBeenCalledTimes(0);

        failures.armRenewalProbe();
        await advanceTimersByTimeAsync(2_000);
        expect(host.reattach).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(3_000);
        expect(host.reattach).toHaveBeenCalledTimes(2);
        failures.cancelProbe();
    });

    // The fresh session overflowing too is the end of it: nothing is coming back, and nothing here would fix it.
    it(`is the error line when the fresh re-run overflowed as well, with nothing to press and nothing to watch`, async () => {
        const host = hostOf();
        const failures = new TurnFailures(host);
        const sentence = `Prompt is too long. A fresh session could not hold this turn either.`;
        failures.apply({ kind: `error`, code: `context-overflow`, message: sentence });

        expect(host.error.value).toBe(sentence);
        expect(host.pickUp.value).toBeUndefined();
        failures.armRenewalProbe();
        await advanceTimersByTimeAsync(40_000);
        expect(host.reattach).toHaveBeenCalledTimes(0);
    });
});

// The sandbox keeps one hold per turn and each failure replaces it: a Claude 401 promised "continues automatically", a
// stop came a second later, and the chat kept the promise, a renewal clock and, 76 s on, a "reconnect the account"
// banner of its own making, while the account went on answering for two hours.
describe(`a resume the sandbox promised`, () => {
    const REFUSED = { kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` } as const;
    const STOPPED = { kind: `error`, message: `Claude Code returned an error result: 401` } as const;
    beforeEach(() => {
        jest.useFakeTimers();
        refreshAccounts.mockClear();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it(`is taken back by a stop later in the same turn, which ends the renewal wait and probes for nothing`, async () => {
        const host = hostOf();
        const failures = new TurnFailures(host);
        failures.apply(REFUSED);
        expect(failures.credentialRenewal.value).toEqual({ since: expect.any(Number) });
        expect(failures.resumeWithdrawn.value).toBeUndefined();

        failures.apply(STOPPED);
        expect(failures.credentialRenewal.value).toBeUndefined();
        expect(failures.resumeWithdrawn.value).toBe(`Claude Code returned an error result: 401`);
        // The stop's own way on is what the chat shows.
        expect(host.pickUp.value).toEqual({ reason: `stopped` });
        failures.armRenewalProbe();
        await advanceTimersByTimeAsync(120_000);
        expect(host.reattach).toHaveBeenCalledTimes(0);

        // The next turn starting is newer than any of it.
        failures.clear();
        expect(failures.resumeWithdrawn.value).toBeUndefined();
    });

    it(`stands when the next failure promises again, and nothing is taken back that was never promised`, () => {
        const host = hostOf();
        const failures = new TurnFailures(host);
        failures.apply(REFUSED);
        failures.apply(REFUSED);
        expect(failures.resumeWithdrawn.value).toBeUndefined();
        expect(failures.credentialRenewal.value).toEqual({ since: expect.any(Number) });

        const unpromised = new TurnFailures(hostOf());
        unpromised.apply(STOPPED);
        unpromised.apply(STOPPED);
        expect(unpromised.resumeWithdrawn.value).toBeUndefined();
    });

    it(`says the turn stopped when no resumed run turns up, and leaves "reconnect" to the sandbox's own account list`, async () => {
        const notices: string[] = [];
        const host = {
            ...hostOf(),
            transcript: unstubbed<FailureHost["transcript"]>(`transcript`, {
                notice: (text: string) => notices.push(text),
                persist: () => undefined,
            }),
            selection: unstubbed<FailureHost["selection"]>(`selection`, { provider: ref(`claude`) }),
        };
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
        const failures = new TurnFailures(host);
        failures.apply(REFUSED);
        failures.armRenewalProbe();
        // 1 s, then 25 probes 3 s apart: the whole budget, with nothing found.
        await advanceTimersByTimeAsync(1_000 + 25 * 3_000);

        expect(host.reattach).toHaveBeenCalledTimes(25);
        expect(failures.credentialRenewal.value).toBeUndefined();
        expect(notices).toEqual([
            `This turn didn't continue by itself after its sign-in was refused, so it stopped where it was. Sending again picks the conversation back up.`,
        ]);
        // No account is marked from here: the list the sandbox answers with is what lights the banner, or not.
        expect(providerAccounts.value[`claude`]).toEqual([{ id: `acct-1`, label: `Claude`, connectedAt: 0 }]);
        jest.useRealTimers();
        await waitFor(() => expect(refreshAccounts).toHaveBeenCalledWith(`claude`));
    });

    it(`asks the sandbox again after a clean turn on a provider with an account marked for reconnecting`, async () => {
        const host = { ...hostOf(), selection: unstubbed<FailureHost["selection"]>(`selection`, { provider: ref(`claude`) }) };
        const marked = { id: `acct-1`, label: `Claude`, connectedAt: 0, needsReauth: true };
        providerAccounts.value = { ...providerAccounts.value, claude: [marked] };
        const failures = new TurnFailures(host);

        // A turn that failed proves nothing about the account.
        failures.apply(STOPPED);
        failures.settled();
        failures.clear();
        // One that ended on no failure ran on an account that signs in.
        failures.settled();
        jest.useRealTimers();
        await waitFor(() => expect(refreshAccounts).toHaveBeenCalledTimes(1));
        expect(refreshAccounts).toHaveBeenCalledWith(`claude`);

        // Nothing marked, nothing to ask.
        providerAccounts.value = { ...providerAccounts.value, claude: [{ ...marked, needsReauth: false }] };
        failures.settled();
        await Promise.resolve();
        expect(refreshAccounts).toHaveBeenCalledTimes(1);
    });
});
