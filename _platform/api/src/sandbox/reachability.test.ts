import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { INGRESS_TEST_PUBLIC_KEY, testIngressConfig } from "../testing.js";
import { ensureReachability, ingressEnabled, sandboxHostname } from "./reachability.js";

/* Reachability is a pure function now, so these are the assertions of one: the same inputs give the same
 * claim, the claim verifies against the public key the ingress will hold, and nothing is written anywhere.
 * There is no hub left to fake, so the HTTP double this suite's predecessor stood up is gone with it. */

const config = (ingress: Partial<typeof testIngressConfig> = {}): Config =>
    ({ ingress: { ...testIngressConfig, ...ingress }, secrets: { key: `` } }) as Config;

// The row as the routes load it: `token` is the encrypted column, which with an empty secrets.key is the
// plaintext connect token (crypto.ts passes through), so the fixture reads as what it is.
const row = { id: `s1`, token: `tok` };

describe(`ingressEnabled`, () => {
    it(`is on only with both a signing key and an address to dial`, () => {
        expect(ingressEnabled(config())).toBe(true);
        expect(ingressEnabled(config({ signingKey: `` }))).toBe(false);
        expect(ingressEnabled(config({ url: `` }))).toBe(false);
    });
});

describe(`sandboxHostname`, () => {
    /* The name is the fabric swap's one hard compatibility promise: it is in DNS, in the daemon's announce,
     * and in links people have shared. Derived here from the digest rather than transcribed, so this pins the
     * DERIVATION and not a string somebody typed twice. */
    it(`is sandbox-<id>.<zone> over the connect token's digest`, () => {
        expect(sandboxHostname(`sbx.test`, `tok`)).toBe(`${sandboxSubdomain(sandboxIdFromToken(`tok`)!)}.sbx.test`);
    });

    // An empty token yields no id, so there is no name to give: `sandbox-.<zone>` is the honest nonsense, and
    // the mint below is where that row is actually refused.
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

    /* A grant signed by SOMEBODY ELSE's key is refused, which is the whole security property: the hostnames
     * say who owns what, and this signature is the only thing that proves a dialer is that owner. Without it
     * the edge would route a sandbox's traffic to whoever asked for its id first. */
    it(`mints a grant nobody else's key can produce`, () => {
        const { grant } = ensureReachability(config(), row);
        const otherPlatform = ensureReachability(config({ signingKey: testIngressConfig.signingKey }), { id: `s2`, token: `other` });

        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, grant)).not.toBe(undefined);
        // Same key, different sandbox: the SUBJECT is what differs, so a grant cannot be replayed for another id.
        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, otherPlatform.grant)?.sandboxId).toBe(sandboxIdFromToken(`other`));
    });

    /* IDEMPOTENT IN THE ONLY SENSE THAT MATTERS. The hub era bought this with a cached column: mint twice and a
     * sandbox would otherwise have two accounts and lose an address. Here the identity is the sandbox's own id,
     * so a second mint is the same claim — which is what lets the routes call this on every setup mint, hosted
     * provision and restart with nothing to reconcile. The bytes may differ (the contract's `iat`), and that
     * is exactly why this asserts on the verified CLAIM rather than on the string. */
    it(`claims the same thing every time it is called, with nothing cached to make that true`, () => {
        const first = ensureReachability(config(), row);
        const second = ensureReachability(config(), row);

        expect(verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, second.grant)?.sandboxId).toBe(
            verifyReachabilityGrant(INGRESS_TEST_PUBLIC_KEY, first.grant)?.sandboxId,
        );
        expect(second.hostname).toBe(first.hostname);
    });

    /* A row with no connect token has no id, and the contract refuses to sign for one rather than minting a
     * grant naming the empty string — which the ingress could never route and which would verify perfectly. */
    it(`refuses to sign for a row with no connect token`, () => {
        expect(() => ensureReachability(config(), { id: `s1`, token: `` })).toThrow(/12-hex sandbox id/);
    });
});
