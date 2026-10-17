import type { ProofMethod } from "@intentic/sandbox-contract/schemas/system";
import { type Listener, LOOPBACK_LISTENER } from "./listener.js";

/* WHAT A WAY OF PROVING WHO YOU ARE MAY DO, beyond naming who: which proofs pass the require-passkey policy, and which
stand on one way in only. ../auth.ts asks both of every proof it takes. */

// The proofs the require-passkey policy lets through: a passkey; a recovery code, which exists to get an owner with no
// passkey left back to registering one; and the machine that runs the sandbox (../host/host-session.ts), since the
// policy keeps out somebody holding the owner's Google account, and whoever holds the machine is root over this
// container already.
const MEETS_PASSKEY_POLICY: ReadonlySet<ProofMethod> = new Set(["passkey", "recovery", "host"]);

export const meetsPasskeyPolicy = (methods: readonly ProofMethod[]): boolean => methods.some((method) => MEETS_PASSKEY_POLICY.has(method));

// Proofs that stand on one way in only (listener.ts). `host` is the machine's own word: it holds where the machine is,
// on the loopback port netd publishes to it alone, so a copy of its token (a backed-up home folder, a disk image) is
// worth nothing over the tunnel. Checked on every use, a renewal's included, which keeps the methods it renews.
const BOUND_TO_LISTENER: ReadonlyMap<ProofMethod, string> = new Map([["host", LOOPBACK_LISTENER]]);

// Throws for proof methods one of which is bound to a listener this request did not come in on. Pure.
export const assertChannel = (methods: readonly ProofMethod[], listener: Listener): void => {
    for (const method of methods) {
        const bound = BOUND_TO_LISTENER.get(method);
        if (bound !== undefined && listener !== bound) {
            throw new Error(`a session proven by ${method} is accepted only on this machine's own loopback port`);
        }
    }
};
