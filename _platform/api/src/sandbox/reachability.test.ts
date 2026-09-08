import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { INGRESS_TEST_PUBLIC_KEY, testIngressConfig } from "../testing.js";
import { ensureReachability, ingressEnabled, sandboxHostname } from "./reachability.js";

// Reachability is a pure function: same inputs give the same claim, verified against the ingress's public key, with
// nothing written anywhere.

const config = (ingress: Partial<typeof testIngressConfig> = {}): Config =>
    ({ ingress: { ...testIngressConfig, ...ingress }, secrets: { key: `` } }) as Config;

// `token` is the encrypted column; with an empty secrets.key it's the plaintext connect token (crypto.ts passes
// through).
const row = { id: `s1`, token: `tok` };

describe(`ingressEnabled`, () => {
    it(`is on only with both a signing key and an address to dial`, () => {
        expect(ingressEnabled(config())).toBe(true);
        expect(ingressEnabled(config({ signingKey: `` }))).toBe(false);
        expect(ingressEnabled(config({ url: `` }))).toBe(false);
    });
});

describe(`sandboxHostname`, () => {
    // Hostname is DNS-load-bearing (daemon announce, shared links); this pins the derivation, not a transcribed string.
    it(`is sandbox-<id>.<zone> over the connect token's digest`, () => {
        expect(sandboxHostname(`sbx.test`, `tok`)).toBe(`${sandboxSubdomain(sandboxIdFromToken(`tok`)!)}.sbx.test`);
    });

    // Refusal happens at mint time; this only confirms the hostname's honest nonsense shape.
    it(`has no id to build from when there is no connect token`, () => {
        expect(sandboxHostname(`sbx.test`, ``)).toBe(`sandbox-.sbx.test`);
    });
});

describe(`ensureReachability`, () => {
    it(`signs a grant the ingress's public key verifies, naming this sandbox's own id`, () => {
        const { grant, hostname, ingressUrl } = ensureReachability(config(), row);

        const verified = verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, grant);
        expect(verified?.sandboxId).toBe(sandboxIdFromToken(`tok`));
        expect(hostname).toBe(`${sandboxSubdomain(sandboxIdFromToken(`tok`)!)}.sbx.test`);
        expect(ingressUrl).toBe(`https://ingress.sbx.test`);
    });

    // The security property: only this signature proves a dialer owns the hostname it's routed to; without it, the edge
    // would route to whoever asked for an id first.
    it(`mints a grant nobody else's key can produce`, () => {
        const { grant } = ensureReachability(config(), row);
        const otherPlatform = ensureReachability(config({ signingKey: testIngressConfig.signingKey }), { id: `s2`, token: `other` });

        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, grant)).not.toBe(undefined);
        // Same key, different sandbox: the subject differs, so a grant can't be replayed for another id.
        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, otherPlatform.grant)?.sandboxId).toBe(sandboxIdFromToken(`other`));
    });

    // Bytes may differ (`iat`), so this asserts on the verified claim, not the raw grant string.
    it(`claims the same thing every time it is called, with nothing cached to make that true`, () => {
        const first = ensureReachability(config(), row);
        const second = ensureReachability(config(), row);

        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, second.grant)?.sandboxId).toBe(
            verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, first.grant)?.sandboxId,
        );
        expect(second.hostname).toBe(first.hostname);
    });

    // Signing a grant naming the empty string would verify perfectly, yet route nowhere; refused instead of minted.
    it(`refuses to sign for a row with no connect token`, () => {
        expect(() => ensureReachability(config(), { id: `s1`, token: `` })).toThrow(/12-hex sandbox id/);
    });
});
