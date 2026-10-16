import { KEYRING_GRANT_TTL_MAX_MS } from "@intentic/sandbox-contract/schemas/keyring";

// EVERY "ASK THE PERSON AT THIS COMPUTER" MOMENT goes through one Consent: a release under `each-use`, a typing that
// misses an entry's rules, a value taken in, a widening edit, a pairing, an askpass answer, an upgrade. Each request
// carries a title and a message that name what is asked for, by which sandbox or program, and where the value goes;
// the implementations show exactly that. While the vault is locked a yes counts only together with the vault key the
// person's unlock produced (a Hello signature, or the passphrase), so a prompt nobody answered cannot open anything.
//
// The ways of asking, best first: Windows Hello (consent-windows.ts), the keyring's passphrase in a dialog of the
// platform's own (consent-windows.ts, consent-posix.ts), and a refusal where there is no way to ask. One prompt at a
// time: a second request waits for the first, and is answered "busy" once it has waited as long as a grant lives.

// What a consent needs to open the vault, handed over by the core so the implementation never holds the wraps.
export interface VaultOpener {
    // The vault key for `passphrase`, or undefined when it is not the keyring's.
    readonly withPassphrase: (passphrase: string) => Promise<Buffer | undefined>;
    // Present where the vault is wrapped for Windows Hello.
    readonly hello?: HelloOpener;
}

export interface HelloOpener {
    readonly credential: string;
    readonly challenge: string;
    // The vault key for a Hello signature over `challenge`, or undefined when it is not the enrolled credential's.
    readonly withSignature: (signature: Buffer) => Buffer | undefined;
}

export interface ConsentRequest {
    // What is asked, in a few words: "Release GITHUB_TOKEN?".
    readonly title: string;
    // Who asks, for what, and where it goes, in sentences.
    readonly message: string;
    // The vault is locked: the answer must open it.
    readonly unlock: boolean;
    // Absent before setup, when there is nothing to open.
    readonly opener: VaultOpener | undefined;
    // How long to wait for another prompt to close first. Default: as long as a grant lives.
    readonly waitMs?: number;
}

export type ConsentRefusal = { readonly ok: false; readonly code: "declined" | "busy" | "locked"; readonly reason: string };

export type ConsentAnswer =
    | {
          readonly ok: true;
          // The vault key the answer produced, when it produced one (Hello's signature, the passphrase). Absent for a
          // plain yes while unlocked (Windows Hello's consent verifier).
          readonly vaultKey: Buffer | undefined;
          readonly how: "hello" | "passphrase" | "verified";
      }
    | ConsentRefusal;

export type HelloResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly cancelled: boolean; readonly reason: string };

export interface HelloEnrolment {
    // The signature over the challenge, which the Hello wrap's key is derived from.
    readonly signature: Buffer;
    // The credential's public key, X.509 SubjectPublicKeyInfo DER as base64, which hardened mode pins.
    readonly publicKey: string;
}

// Windows Hello as the keyring drives it (consent-windows.ts); a test passes a fake.
export interface HelloDriver {
    readonly available: () => Promise<boolean>;
    // Create (or replace) the credential and sign `challenge` with it, the person's first gesture at setup.
    readonly enrol: (credential: string, challenge: string, notice: Notice) => Promise<HelloResult<HelloEnrolment>>;
    // Sign `challenge` with the credential: the gesture that unlocks.
    readonly sign: (credential: string, challenge: string, notice: Notice) => Promise<HelloResult<Buffer>>;
    // A yes with Hello's own verifier, which shows `notice.message` itself: for consent while already unlocked.
    readonly verify: (notice: Notice) => Promise<HelloResult<true>>;
}

export interface Notice {
    readonly title: string;
    readonly message: string;
}

export type PromptAnswer =
    | { readonly kind: "answered"; readonly passphrase: string }
    | { readonly kind: "cancelled" }
    // No dialog could be shown here (no display, no prompt program): why, in words.
    | { readonly kind: "unavailable"; readonly reason: string };

// A passphrase dialog of the platform's own.
export type PassphrasePrompt = (notice: Notice) => Promise<PromptAnswer>;

export interface Consent {
    readonly ask: (request: ConsentRequest) => Promise<ConsentAnswer>;
    // Windows Hello, where this computer has it: for `setup`'s enrolment and `state`'s list of ways to unlock.
    readonly hello: HelloDriver | undefined;
}

const nobodyToAsk = (request: ConsentRequest, reason: string): ConsentRefusal =>
    request.unlock ? { ok: false, code: "locked", reason: `The keyring is locked and ${reason}` } : { ok: false, code: "declined", reason: `Nobody could be asked: ${reason}` };

// No way to ask a person here: every request is refused, saying why.
export const refusingConsent = (why: string): Consent => ({
    ask: (request) => Promise.resolve(nobodyToAsk(request, why)),
    hello: undefined,
});

// How many times a mistyped passphrase is asked again before the request is refused.
const PASSPHRASE_TRIES = 3;

// The passphrase as consent: asked for every time, and checked against the vault, so a yes is a person who knows it.
// While unlocked it is still asked and checked: a dialog any program of this user could click through is not a person.
export const passphraseConsent = (prompt: PassphrasePrompt): Consent => ({
    hello: undefined,
    ask: async (request) => {
        const opener = request.opener;
        if (opener === undefined) {
            return nobodyToAsk(request, "the keyring is not set up yet: `intentic-machine keyring setup` sets it up.");
        }
        for (let attempt = 1; attempt <= PASSPHRASE_TRIES; attempt++) {
            const message = attempt === 1 ? request.message : `That was not the keyring's passphrase. ${request.message}`;
            const answer = await prompt({ title: request.title, message });
            if (answer.kind === "cancelled") {
                return { ok: false, code: "declined", reason: "The person at the computer said no." };
            }
            if (answer.kind === "unavailable") {
                return nobodyToAsk(request, `no passphrase prompt could be shown: ${answer.reason}.`);
            }
            const vaultKey = await opener.withPassphrase(answer.passphrase);
            if (vaultKey !== undefined) {
                return { ok: true, vaultKey, how: "passphrase" };
            }
        }
        return { ok: false, code: "declined", reason: `The passphrase was not the keyring's, ${String(PASSPHRASE_TRIES)} times.` };
    },
});

// Windows Hello first, the passphrase when Hello cannot answer: locked, a Hello signature over the vault's challenge
// opens it; unlocked, Hello's consent verifier says yes. A person who cancels Hello is a no, not a reason to ask again.
export const helloConsent = (hello: HelloDriver, fallback: Consent): Consent => ({
    hello,
    ask: async (request) => {
        const notice = { title: request.title, message: request.message };
        if (!(await hello.available())) {
            return await fallback.ask(request);
        }
        const opener = request.opener?.hello;
        if (request.unlock) {
            if (opener === undefined) {
                return await fallback.ask(request);
            }
            const signed = await hello.sign(opener.credential, opener.challenge, notice);
            if (!signed.ok) {
                return signed.cancelled ? { ok: false, code: "declined", reason: "The person at the computer said no." } : await fallback.ask(request);
            }
            const vaultKey = opener.withSignature(signed.value);
            // A signature that opens nothing: the credential was replaced (Hello reset). The passphrase still opens it.
            return vaultKey === undefined ? await fallback.ask(request) : { ok: true, vaultKey, how: "hello" };
        }
        const verified = await hello.verify(notice);
        if (verified.ok) {
            return { ok: true, vaultKey: undefined, how: "verified" };
        }
        return verified.cancelled ? { ok: false, code: "declined", reason: "The person at the computer said no." } : await fallback.ask(request);
    },
});

// One prompt at a time. A request that finds one open waits for it to close, at most `waitMs` (default: as long as a
// grant lives, since a grant's answer is worth nothing later), and is then answered "busy".
export const serialConsent = (inner: Consent, defaultWaitMs: number = KEYRING_GRANT_TTL_MAX_MS): Consent => {
    let tail: Promise<void> = Promise.resolve();
    return {
        hello: inner.hello,
        ask: async (request) => {
            const before = tail;
            let release = (): void => undefined;
            const mine = new Promise<void>((resolve) => {
                release = resolve;
            });
            tail = before.then(async () => await mine);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<"late">((resolve) => {
                timer = setTimeout(() => resolve("late"), request.waitMs ?? defaultWaitMs);
                timer.unref?.();
            });
            const turn = await Promise.race([before.then(() => "turn" as const), late]);
            clearTimeout(timer);
            if (turn === "late") {
                // The turn still comes; handed straight on, so the requests behind this one are not held for it.
                void before.then(release);
                return { ok: false, code: "busy", reason: "Another prompt is open at the computer: ask again once it is answered." };
            }
            try {
                return await inner.ask(request);
            } finally {
                release();
            }
        },
    };
};
