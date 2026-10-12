import { redeemWhileWarming } from "@intentic/sandbox-contract/pairing-redeem";
import { PeerEnrollmentAnswerSchema, webextEnrollUrl } from "@intentic/sandbox-contract/webext";

// Redeems a pairing code's one-time token for the durable one, with the machine agent's semantics
// (_devices/machine/src/daemon-base.ts postWhileWarming): a sandbox still warming up answers 5xx through its tunnel, or
// nothing at all, and is asked again; only a 401 means the code has expired. Reading every refusal as "expired" sent
// people for a fresh code that would have met the same cold sandbox.

export type EnrollOutcome =
    | { readonly kind: "enrolled"; readonly token: string }
    // No answer at all, after every attempt.
    | { readonly kind: "unreachable" }
    // Still 5xx after every attempt: up, but not ready to redeem.
    | { readonly kind: "starting"; readonly status: number }
    | { readonly kind: "expired" }
    // Any other refusal, kept with its status rather than guessed at.
    | { readonly kind: "refused"; readonly status: number }
    // A 2xx whose body is not an enrollment answer.
    | { readonly kind: "unreadable" };

export interface EnrollOptions {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly fetch?: typeof fetch;
}

// Five tries two seconds apart: the popup is waiting on this answer, so it gives up long before the machine agent does.
const ATTEMPTS = 5;
const DELAY_MS = 2_000;
const ATTEMPT_TIMEOUT_MS = 15_000;

export const redeemPairing = async (
    pairing: { readonly url: string; readonly token: string },
    options: EnrollOptions = {},
): Promise<EnrollOutcome> => {
    const { attempts = ATTEMPTS, delayMs = DELAY_MS, fetch: send = fetch } = options;
    const outcome = await redeemWhileWarming(
        (_attempt, signal) =>
            send(webextEnrollUrl(pairing.url), { method: "POST", headers: { "x-intentic-pair": pairing.token }, signal: signal ?? null }),
        // A try that hangs counts as unreachable and is asked again, rather than leaving the popup waiting for good.
        { attempts, delayMs, timeoutMs: ATTEMPT_TIMEOUT_MS },
    );
    if (outcome.kind === "unreachable") {
        return { kind: "unreachable" };
    }
    const last = outcome.response;
    if (last.status >= 500) {
        return { kind: "starting", status: last.status };
    }
    if (last.status === 401) {
        return { kind: "expired" };
    }
    if (!last.ok) {
        return { kind: "refused", status: last.status };
    }
    // allow(silent-catch): a body that is not JSON fails the schema and is answered as unreadable
    const answer = PeerEnrollmentAnswerSchema.safeParse(await last.json().catch(() => undefined));
    return answer.success ? { kind: "enrolled", token: answer.data.token } : { kind: "unreadable" };
};
