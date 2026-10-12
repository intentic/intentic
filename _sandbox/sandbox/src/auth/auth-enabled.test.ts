import { assertionsPossible, authEnabled, signInProofs } from "./auth-enabled.js";

const config = (overrides: { clientId?: string; url?: string; publicKey?: string; identityKey?: string; connectToken?: string } = {}) => ({
    google: { clientId: overrides.clientId ?? "" },
    platform: { url: overrides.url ?? "", publicKey: overrides.publicKey ?? "", identityKey: overrides.identityKey ?? "" },
    connectToken: overrides.connectToken ?? "",
});

describe("auth-enabled", () => {
    it("turns auth on for a Google client id, a platform identity key, or a platform to learn one from", () => {
        expect(authEnabled(config())).toBe(false);
        expect(authEnabled(config({ connectToken: "ict_x" }))).toBe(false);
        expect(authEnabled(config({ clientId: "cid" }))).toBe(true);
        expect(authEnabled(config({ identityKey: "pem" }))).toBe(true);
        expect(authEnabled(config({ url: "https://api.intentic.dev", connectToken: "ict_x" }))).toBe(true);
    });

    it("verifies assertions only where a connect token names the sandbox and a key can be had", () => {
        expect(assertionsPossible(config({ url: "https://api.intentic.dev" }))).toBe(false);
        expect(assertionsPossible(config({ url: "https://api.intentic.dev", connectToken: "ict_x" }))).toBe(true);
        expect(assertionsPossible(config({ identityKey: "pem", connectToken: "ict_x" }))).toBe(true);
    });

    it("names the proofs a session opens with, as /health serves them", () => {
        expect(signInProofs(config({ clientId: "cid" }))).toEqual(["google", "passkey", "recovery"]);
        expect(signInProofs(config({ clientId: "cid", url: "https://api.intentic.dev", connectToken: "ict_x" }))).toEqual(["google", "email", "passkey", "recovery"]);
        expect(signInProofs(config({ clientId: "cid", publicKey: "pem", identityKey: "pem", connectToken: "ict_x" }))).toEqual([
            "google",
            "ticket",
            "email",
            "passkey",
            "recovery",
        ]);
    });
});
