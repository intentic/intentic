import { sleep } from "@intentic/base/async";
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
    readonly sleep?: (ms: number) => Promise<void>;
}

// Five tries two seconds apart: the popup is waiting on this answer, so it gives up long before the machine agent does.
const ATTEMPTS = 5;
const DELAY_MS = 2_000;

export const redeemPairing = async (pairing: { readonly url: string; readonly token: string }, options: EnrollOptions = {}): Promise<EnrollOutcome> => {
    const { attempts = ATTEMPTS, delayMs = DELAY_MS, fetch: send = fetch, sleep: pause = sleep } = options;
    let last: Response | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1) {
            await pause(delayMs);
        }
        // allow(silent-catch): a network failure is retried, then answered as unreachable below
        last = await send(webextEnrollUrl(pairing.url), { method: "POST", headers: { "x-intentic-pair": pairing.token } }).catch(() => undefined);
        if (last !== undefined && last.status < 500) {
            break;
        }
    }
    if (last === undefined) {
        return { kind: "unreachable" };
    }
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
