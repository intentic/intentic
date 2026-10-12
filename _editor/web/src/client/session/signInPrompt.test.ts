import { completeSignIn, dismissSignIn, escalateSignIn, offerPasskey, raiseSignIn, sameBearer, useSignInPrompt } from "./signInPrompt";

// The one question the gate is asked and the one answer the session module waits for: raising shows it, settling
// clears it, and a second raise ends the first with nothing.

const TARGET = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };
const OTHER = { sandboxId: `sb-2`, base: `https://other.test`, connectToken: undefined };
const SESSION = { token: `sess`, expiresAt: 4_102_444_800_000, email: `o@x.com` };
// The step-up's bearers, as the session module hands them over: a proof good for every call, and a mint per call.
const GOOGLE = sameBearer(`google`);
const MINT = async (): Promise<string> => `pa1.fresh`;

afterEach(() => dismissSignIn());

it(`a proof good for every call of a step-up answers the same proof each time`, async () => {
    expect(await GOOGLE()).toBe(`google`);
    expect(await GOOGLE()).toBe(`google`);
});

it(`raising shows the prompt; completing hands the session back and clears it`, async () => {
    const { prompt } = useSignInPrompt();
    const outcome = raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: true, bearer: GOOGLE });
    expect(prompt.value).toEqual({ kind: `step-up`, target: TARGET, enrolled: true, bearer: GOOGLE });
    completeSignIn(SESSION);
    expect(await outcome).toEqual(SESSION);
    expect(prompt.value).toBeUndefined();
});

it(`dismissing settles with nothing; completing with nobody waiting does nothing`, async () => {
    const outcome = raiseSignIn({ kind: `choose`, target: TARGET, passkey: false });
    dismissSignIn();
    expect(await outcome).toBeUndefined();
    completeSignIn(SESSION);
    expect(useSignInPrompt().prompt.value).toBeUndefined();
});

it(`a second raise ends the first with nothing: one establish at a time owns the gate`, async () => {
    const first = raiseSignIn({ kind: `choose`, target: TARGET, passkey: false });
    const second = raiseSignIn({ kind: `choose`, target: OTHER, passkey: false });
    expect(await first).toBeUndefined();
    expect(useSignInPrompt().prompt.value).toEqual({ kind: `choose`, target: OTHER, passkey: false });
    completeSignIn(SESSION);
    expect(await second).toEqual(SESSION);
});

it(`the passkey offer lands only on the choose prompt for the same target`, () => {
    const { prompt } = useSignInPrompt();
    void raiseSignIn({ kind: `choose`, target: TARGET, passkey: false });
    offerPasskey(OTHER, true);
    expect(prompt.value).toEqual({ kind: `choose`, target: TARGET, passkey: false });
    offerPasskey(TARGET, true);
    expect(prompt.value).toEqual({ kind: `choose`, target: TARGET, passkey: true });
    dismissSignIn();

    void raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: false, bearer: GOOGLE });
    offerPasskey(TARGET, true);
    expect(prompt.value).toEqual({ kind: `step-up`, target: TARGET, enrolled: false, bearer: GOOGLE });
});

// "Continue as" on the wall spent an assertion the sandbox took, and its passkey rule wants more: the same prompt becomes
// the step-up, so the ceremony's session settles the very establish that raised the choice.
it(`escalating turns the standing choice into the step-up without settling it`, async () => {
    const { prompt } = useSignInPrompt();
    const outcome = raiseSignIn({ kind: `choose`, target: TARGET, passkey: false, withoutGoogle: true });
    escalateSignIn(TARGET, { error: `this sandbox requires a passkey`, requires: `passkey`, enrolled: false }, MINT);
    expect(prompt.value).toEqual({ kind: `step-up`, target: TARGET, enrolled: false, bearer: MINT });
    completeSignIn(SESSION);
    expect(await outcome).toEqual(SESSION);
});

it(`escalating with nothing waiting puts nothing up`, () => {
    escalateSignIn(TARGET, { error: `this sandbox requires a passkey`, requires: `passkey`, enrolled: true }, MINT);
    expect(useSignInPrompt().prompt.value).toBeUndefined();
});
