import { createPublicKey } from "node:crypto";

// The public half of the key the platform signs identity assertions with (sandbox-contract policy/identity-assertion.ts).
// A hosted machine is handed it in its env (PLATFORM_IDENTITY_KEY), since it boots before it first announces; every
// sandbox then learns the newest from each announce answer, so one started by any `ic` has it within seconds of its
// first announce and follows a rotation within the hour. Held in memory only: the platform answers the browser that
// asks for an assertion, so a daemon that cannot reach the platform after a restart has nothing to verify anyway.
export interface PlatformIdentityKey {
    readonly current: () => string | undefined;
    // Takes a key the platform announced; one that is not an Ed25519 public key is ignored, keeping the last good one.
    readonly learn: (pem: string) => void;
    // The key, waiting up to `waitMs` for the first one when none is known yet.
    readonly settled: (waitMs: number) => Promise<string | undefined>;
}

const isEd25519PublicKey = (pem: string): boolean => {
    try {
        return createPublicKey(pem).asymmetricKeyType === "ed25519";
    } catch {
        // allow(silent-catch): text that does not parse as a key is the answer itself, not a fault: it is no key of ours.
        return false;
    }
};

export const createPlatformIdentityKey = (initial: string): PlatformIdentityKey => {
    let key = initial !== "" && isEd25519PublicKey(initial) ? initial : undefined;
    let waiters: Array<(learned: string) => void> = [];
    return {
        current: () => key,
        learn: (pem) => {
            if (pem === key || !isEd25519PublicKey(pem)) {
                return;
            }
            key = pem;
            const woken = waiters;
            waiters = [];
            for (const wake of woken) {
                wake(pem);
            }
        },
        settled: (waitMs) => {
            if (key !== undefined || waitMs <= 0) {
                return Promise.resolve(key);
            }
            return new Promise((resolve) => {
                const wake = (learned: string): void => {
                    clearTimeout(timer);
                    resolve(learned);
                };
                const timer = setTimeout(() => {
                    waiters = waiters.filter((waiter) => waiter !== wake);
                    resolve(key);
                }, waitMs);
                waiters.push(wake);
            });
        },
    };
};
