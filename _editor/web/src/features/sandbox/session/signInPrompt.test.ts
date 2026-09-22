import { it, expect, afterEach } from "bun:test";
import { completeSignIn, dismissSignIn, offerPasskey, raiseSignIn, useSignInPrompt } from "./signInPrompt";

// The one question the gate is asked and the one answer the session module waits for: raising shows it, settling
// clears it, and a second raise ends the first with nothing.

const TARGET = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };
const OTHER = { sandboxId: `sb-2`, base: `https://other.test`, connectToken: undefined };
const SESSION = { token: `sess`, expiresAt: 4_102_444_800_000, email: `o@x.com` };

afterEach(() => dismissSignIn());

it(`raising shows the prompt; completing hands the session back and clears it`, async () => {
    const { prompt } = useSignInPrompt();
    const outcome = raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: true, bearer: `google` });
    expect(prompt.value).toEqual({ kind: `step-up`, target: TARGET, enrolled: true, bearer: `google` });
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

    void raiseSignIn({ kind: `step-up`, target: TARGET, enrolled: false, bearer: `google` });
    offerPasskey(TARGET, true);
    expect(prompt.value).toEqual({ kind: `step-up`, target: TARGET, enrolled: false, bearer: `google` });
});
