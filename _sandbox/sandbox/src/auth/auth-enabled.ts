import type { ProofMethod } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";

// Whether this daemon authenticates callers at all. It does when it can verify a person by some proof: a Google ID token
// (GOOGLE_CLIENT_ID), or the platform's identity assertion, whose key it was handed (PLATFORM_IDENTITY_KEY) or learns
// from the platform it announces to with its connect token. A daemon that can verify nobody yet still refuses everyone
// until it can; only one with none of these is the loopback daemon whose routes are open.
export const authEnabled = (config: Pick<Config, "google" | "platform" | "connectToken">): boolean =>
    config.google.clientId !== "" || config.platform.identityKey !== "" || (config.platform.url !== "" && config.connectToken !== "");

// Whether the platform's identity assertion can be verified here: it names this sandbox by the id its connect token
// derives, and the key comes from the env or the platform this sandbox announces to.
export const assertionsPossible = (config: Pick<Config, "platform" | "connectToken">): boolean =>
    config.connectToken !== "" && (config.platform.identityKey !== "" || config.platform.url !== "");

// The proofs a session can be opened with here, which `/health` names before anyone signs in (the route list arrives
// only after a sign-in). A passkey and a recovery code exist only once an owner bound, but the routes are always there.
export const signInProofs = (config: Pick<Config, "google" | "platform" | "connectToken">): ProofMethod[] => {
    const proofs: ProofMethod[] = [];
    if (config.google.clientId !== "") {
        proofs.push("google");
    }
    if (config.platform.publicKey !== "" && config.connectToken !== "") {
        proofs.push("ticket");
    }
    if (assertionsPossible(config)) {
        proofs.push("email");
    }
    proofs.push("passkey", "recovery");
    return proofs;
};
