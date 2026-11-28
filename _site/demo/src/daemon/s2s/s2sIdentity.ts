import type { S2sDomainClaim, S2sMe, S2sRecoveryMinted, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { refuse } from "@intentic/contract-serve";
import { DEMO_SANDBOX } from "../../platform";
import { DEMO_DAEMON_ORIGIN } from "../../transport";
import { LAPTOP_SANDBOX } from "../../world/sandboxRegistry";

// What each sandbox of the demo's world is to another one (docs/architecture/messages.md): its signed document, the own
// domains it claimed, its recovery key and how many earlier keys it keeps. Nothing here is real cryptography; the keys,
// fingerprints and signatures only have the shapes the contract parses, made from a seed so they stay the same across a
// reload. This sandbox claims one verified domain and one still waiting for its record.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE32 = `abcdefghijklmnopqrstuvwxyz234567`;

/** A fingerprint-shaped string, the same for the same seed: `isk1:` and 52 base32 characters. */
export const fingerprintOf = (seed: string, prefix = `isk1:`): string => {
    let hash = 2_166_136_261;
    let out = ``;
    for (let at = 0; out.length < 52; at += 1) {
        hash = Math.imul(hash ^ (seed.charCodeAt(at % seed.length) + at), 16_777_619) >>> 0;
        out += BASE32[hash % 32];
    }
    return `${prefix}${out}`;
};

export const keysOf = (seed: string): SandboxIdentity[`keys`] => ({
    ed25519: `ed${fingerprintOf(seed).slice(5, 40)}`,
    mldsa65: `ml${fingerprintOf(`${seed}/dsa`).slice(5)}`,
    x25519: `x${fingerprintOf(`${seed}/x`).slice(5, 40)}`,
    mlkem768: `kem${fingerprintOf(`${seed}/kem`).slice(5)}`,
});
export const SIG = { ed25519: `sig`, mldsa65: `sig` } as const;

const documentFor = (sandbox: string, name: string, host: string, seed: string, domains: readonly string[] = [], recovery?: string): SandboxIdentity => {
    const document: SandboxIdentity = {
        v: 1,
        sandbox,
        name,
        host,
        domains: [...domains].toSorted(),
        keys: keysOf(seed),
        fingerprint: fingerprintOf(seed),
        protocols: [`s2s/1`],
        issuedAt: Date.now() - 41 * DAY,
        sig: SIG,
    };
    if (recovery !== undefined) {
        document.recovery = recovery;
    }
    return document;
};

/** The host each of the demo's sandboxes is reached at: this one, and the owner's laptop. */
const SHOP_HOST = new URL(DEMO_DAEMON_ORIGIN).hostname;
export const LAPTOP_HOST = new URL(LAPTOP_SANDBOX.origin).hostname;

interface Identity {
    seed: string;
    rotations: number;
    recovery: string | undefined;
    domains: S2sDomainClaim[];
    readonly sandbox: string;
    readonly name: string;
    readonly host: string;
}

const claim = (domain: string, host: string, fingerprint: string, verified: boolean, problem?: string): S2sDomainClaim => {
    const made: S2sDomainClaim = {
        domain,
        verified,
        record: { name: `_intentic.${domain}`, value: `v=isk1 fp=${fingerprint} host=${host}` },
        claimedAt: Date.now() - (verified ? 30 : 2) * DAY,
        checkedAt: Date.now() - (verified ? 5 : 1) * HOUR,
    };
    if (problem !== undefined) {
        made.problem = problem;
    }
    return made;
};

const shopIdentity = (): Identity => {
    const seed = `acme-shop`;
    // The identity starts rotated once, so its key (and every TXT record naming it) is the rotated seed's (keySeed).
    const fingerprint = fingerprintOf(`${seed}#1`);
    return {
        seed,
        rotations: 1,
        recovery: undefined,
        sandbox: DEMO_SANDBOX.id,
        name: DEMO_SANDBOX.name,
        host: SHOP_HOST,
        domains: [
            claim(`shop.acme.dev`, SHOP_HOST, fingerprint, true),
            claim(`acme-shop.example`, SHOP_HOST, fingerprint, false, `No TXT record at _intentic.acme-shop.example yet.`),
        ],
    };
};
const laptopIdentity = (): Identity => ({
    seed: `ada-laptop`,
    rotations: 0,
    recovery: undefined,
    sandbox: LAPTOP_SANDBOX.id,
    name: LAPTOP_SANDBOX.name,
    host: LAPTOP_HOST,
    domains: [],
});

// Each sandbox's identity, by its daemon's address; anything but the laptop is this sandbox.
const identities = new Map<string, Identity>();
const identityAt = (at: URL): Identity => {
    const laptop = at.origin === LAPTOP_SANDBOX.origin;
    const key = laptop ? `laptop` : `shop`;
    const held = identities.get(key) ?? (laptop ? laptopIdentity() : shopIdentity());
    identities.set(key, held);
    return held;
};

const keySeed = (identity: Identity): string => (identity.rotations === 0 ? identity.seed : `${identity.seed}#${identity.rotations}`);

/** The sandbox's own document, as GET /s2s/identity serves it. */
export const identityDocument = (at: URL): SandboxIdentity => {
    const identity = identityAt(at);
    return documentFor(
        identity.sandbox,
        identity.name,
        identity.host,
        keySeed(identity),
        identity.domains.filter((each) => each.verified).map((each) => each.domain),
        identity.recovery,
    );
};

export const meAt = (at: URL): S2sMe => {
    const identity = identityAt(at);
    return { document: identityDocument(at), domains: identity.domains.map((each) => ({ ...each })), recovery: identity.recovery !== undefined, previousKeys: Math.min(identity.rotations, 3) };
};

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const claimDomain = (at: URL, typed: string): S2sMe => {
    const identity = identityAt(at);
    const domain = typed.trim().toLowerCase().replace(/\.$/u, ``);
    if (!DOMAIN.test(domain)) {
        refuse(`${typed} is not a domain name.`, 400);
    }
    if (!identity.domains.some((each) => each.domain === domain)) {
        const made = claim(domain, identity.host, fingerprintOf(keySeed(identity)), false);
        delete made.checkedAt;
        identity.domains.push({ ...made, claimedAt: Date.now() });
    }
    return meAt(at);
};

export const dropDomain = (at: URL, domain: string): S2sMe => {
    const identity = identityAt(at);
    identity.domains = identity.domains.filter((each) => each.domain !== domain);
    return meAt(at);
};

// A check finds what the visitor could not have published: the verified one still matches, any other still has no record.
export const checkDomain = (at: URL, domain: string): S2sMe => {
    const identity = identityAt(at);
    const held = identity.domains.find((each) => each.domain === domain) ?? refuse(`${domain} is not claimed here.`, 404);
    held.checkedAt = Date.now();
    if (!held.verified) {
        held.problem = `No TXT record at _intentic.${domain} yet.`;
    }
    return meAt(at);
};

export const rotate = (at: URL): S2sMe => {
    const identity = identityAt(at);
    identity.rotations += 1;
    const fingerprint = fingerprintOf(keySeed(identity));
    identity.domains = identity.domains.map((each) => ({ ...each, record: { ...each.record, value: `v=isk1 fp=${fingerprint} host=${identity.host}` } }));
    return meAt(at);
};

export const mintRecovery = (at: URL): S2sRecoveryMinted => {
    const identity = identityAt(at);
    const nonce = crypto.randomUUID();
    identity.recovery = fingerprintOf(nonce, `isr1:`);
    return { secret: `isrs1.${btoa(nonce + nonce).replaceAll(`=`, ``).replaceAll(`+`, `-`).replaceAll(`/`, `_`)}`, fingerprint: identity.recovery };
};

export const recover = (at: URL, secret: string): S2sMe => {
    if (!secret.startsWith(`isrs1.`)) {
        refuse(`That is not a recovery key: one starts with isrs1.`, 400);
    }
    return rotate(at);
};
