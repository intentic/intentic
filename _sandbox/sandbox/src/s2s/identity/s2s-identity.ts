import {
    canonicalJson,
    type ExtensionSignDomain,
    formatTxtRecord,
    generateKeySet,
    hybridSign,
    type RandomBytes,
    type S2sKeySet,
    type SignDomain,
    secretKeysOf,
    signIdentity,
    type TxtAnswer,
    txtRecordName,
} from "@intentic/sandbox-contract/s2s";
import type { HybridSig, S2sAttestations, S2sClaims, S2sMe, S2sRecoveryMinted, S2sSandboxVouch, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import type { JsonFile } from "../../store/json-file.js";
import { type AttestationRow, attestationChanges, idsOf, openIdentityAttestations, publishable } from "./identity-attestations.js";
import { type DomainRow, openIdentityDomains, verifiedFor } from "./identity-domains.js";
import { type IdentityKeys, keySetOf, openIdentityKeys, type StoredKeySet, storedOf } from "./identity-keys.js";
import { domainChanges, keyChanges } from "./identity-changes.js";

// THIS SANDBOX'S S2S IDENTITY (docs/architecture/messages.md, "Identity"): its key set, made on first need; its signed
// public document, signed again whenever a fact in it changes; its own domains and their TXT checks; rotation and
// recovery (identity-changes.ts). The one seam the contacts, messages and calls modules reach the keys through: they
// open and sign with it and never read the key file themselves.

// Who this sandbox is, as the daemon's config says: its id, its name and its host.
export interface IdentitySelf {
    readonly sandbox: string;
    readonly name: string;
    readonly host: string;
}

// A key change the contacts are told of (`identity.rotated`): the key it replaced, the new document, and who vouched.
export interface S2sRotation {
    readonly previous: string | undefined;
    readonly document: SandboxIdentity;
    readonly by: "key" | "recovery";
}

// Why a change was not made, and the status its route answers.
export interface IdentityRefusal {
    readonly refused: string;
    readonly status: 400 | 404 | 409;
}

export const isIdentityRefusal = <T extends object>(value: T | IdentityRefusal): value is IdentityRefusal => "refused" in value;

export interface S2sIdentity {
    // The current key set, made on first need.
    readonly current: () => Promise<S2sKeySet>;
    // This sandbox's own signed document, as GET /s2s/identity serves it.
    readonly document: () => Promise<SandboxIdentity>;
    // Every key set an envelope or a session may be sealed to: the current one first, then the kept previous ones.
    readonly openWith: () => Promise<readonly S2sKeySet[]>;
    // A hybrid signature under the current key set over the bytes, for what they are (protocol/s2s sign.ts SignDomain), or
    // (2026-11-28) for an extension's record (extension-sign.ts, the `/extension/identity/sign` door).
    readonly sign: (domain: SignDomain | ExtensionSignDomain, bytes: Uint8Array) => Promise<HybridSig>;
    // The addresses this sandbox answers to: its host, then the own domains its document lists.
    readonly addresses: () => Promise<readonly string[]>;
    // The Identity section's view.
    readonly me: () => Promise<S2sMe>;
    readonly claimDomain: (raw: string) => Promise<S2sMe | IdentityRefusal>;
    readonly removeDomain: (domain: string) => Promise<S2sMe | IdentityRefusal>;
    readonly checkDomain: (domain: string) => Promise<S2sMe | IdentityRefusal>;
    // Every claimed domain checked again: the daily pass.
    readonly checkDomains: () => Promise<void>;
    // A new key set, vouched for by the current one, which is kept to open late arrivals.
    readonly rotate: () => Promise<S2sMe>;
    // A new recovery key, its secret answered this once and never kept.
    readonly mintRecovery: () => Promise<S2sRecoveryMinted>;
    // A new key set vouched for by the pasted recovery key: how a sandbox whose volume was lost gets its identity back.
    readonly recover: (secret: string) => Promise<S2sMe | IdentityRefusal>;
    // Told after every rotation or recovery, so the contacts module can send `identity.rotated`. Answers the unsubscribe.
    readonly onRotated: (listener: (rotation: S2sRotation) => void) => () => void;
    // What other sandboxes vouched for and a person here added (identity-attestations.ts), each checked against the document.
    readonly attestations: () => Promise<S2sAttestations>;
    // One a contact sent, added once it verifies against this document; one per issuer, at most S2S_ATTESTATIONS_KEPT_MAX.
    readonly addAttestation: (
        attestation: AttestationRow["attestation"],
        from: { readonly contact?: string | undefined; readonly message?: string | undefined },
    ) => Promise<S2sAttestations | IdentityRefusal>;
    readonly removeAttestation: (id: string) => Promise<S2sAttestations | IdentityRefusal>;
    // A vouch for another sandbox under its key, signed now by the current key set; refused for claims or dates past the bounds.
    readonly issueVouch: (
        subject: { readonly sandbox: string; readonly address: string; readonly fingerprint: string },
        claims: S2sClaims,
        validUntil: number,
    ) => Promise<S2sSandboxVouch | IdentityRefusal>;
}

export interface IdentityDeps {
    readonly keysPath: string;
    readonly domainsPath: string;
    readonly attestationsPath: string;
    readonly self: () => IdentitySelf;
    readonly resolveTxt: (name: string) => Promise<TxtAnswer>;
    readonly now: () => number;
    readonly random?: RandomBytes;
    readonly warn?: (message: string, error: Error) => void;
}

// What the changes are made on: the two files, the keys with a current set, and the document and view as they stand.
export interface IdentityCore {
    readonly deps: IdentityDeps;
    readonly keysFile: JsonFile<IdentityKeys>;
    readonly domainsFile: JsonFile<{ domains: DomainRow[] }>;
    readonly attestationsFile: JsonFile<{ attestations: AttestationRow[] }>;
    readonly keys: () => Promise<IdentityKeys & { readonly current: StoredKeySet }>;
    readonly document: () => Promise<SandboxIdentity>;
    readonly me: () => Promise<S2sMe>;
}

const domainView = (row: DomainRow, fingerprint: string, host: string): S2sMe["domains"][number] => {
    const view: S2sMe["domains"][number] = {
        domain: row.domain,
        verified: verifiedFor(row, fingerprint, host),
        record: { name: txtRecordName(row.domain), value: formatTxtRecord({ fingerprint, host }) },
        claimedAt: row.claimedAt,
    };
    if (row.checkedAt !== undefined) {
        view.checkedAt = row.checkedAt;
    }
    if (row.problem !== undefined) {
        view.problem = row.problem;
    }
    return view;
};

const createCore = (deps: IdentityDeps): IdentityCore => {
    const keysFile = openIdentityKeys(deps.keysPath);
    const domainsFile = openIdentityDomains(deps.domainsPath);
    const attestationsFile = openIdentityAttestations(deps.attestationsPath);
    let signed: { readonly key: string; readonly document: SandboxIdentity } | undefined;

    // The keys with a current set, made under the file's own lock so two first needs make one.
    const keys = async (): Promise<IdentityKeys & { readonly current: StoredKeySet }> => {
        const read = await keysFile.update((stored) =>
            stored.current === undefined ? { ...stored, current: storedOf(generateKeySet(deps.random), deps.now()) } : stored,
        );
        const { current } = read;
        if (current === undefined) {
            throw new Error("sandbox-identity.json: no current key set after making one");
        }
        return { ...read, current };
    };

    // Signed again only when a fact it carries changed, so its issuedAt says when it last did.
    const document = async (): Promise<SandboxIdentity> => {
        const stored = await keys();
        const current = keySetOf(stored.current);
        const self = deps.self();
        const domains = (await domainsFile.read()).domains.filter((row) => verifiedFor(row, current.fingerprint, self.host)).map((row) => row.domain);
        // Those that hold as of now: one that lapsed since the last signing changes the key, so the document is signed again.
        const attestations = publishable((await attestationsFile.read()).attestations, { sandbox: self.sandbox, fingerprint: current.fingerprint, prev: stored.current.prev }, deps.now());
        const facts = { ...self, domains, recovery: stored.recovery?.fingerprint, attestations };
        const key = canonicalJson({
            ...facts,
            recovery: facts.recovery ?? null,
            attestations: idsOf(attestations),
            fingerprint: current.fingerprint,
            prev: stored.current.prev?.sig ?? null,
        });
        if (signed?.key !== key) {
            signed = { key, document: signIdentity({ ...facts, issuedAt: deps.now() }, current, stored.current.prev) };
        }
        return signed.document;
    };

    const me = async (): Promise<S2sMe> => {
        const doc = await document();
        const stored = await keys();
        return {
            document: doc,
            domains: (await domainsFile.read()).domains.map((row) => domainView(row, doc.fingerprint, doc.host)),
            recovery: stored.recovery !== undefined,
            previousKeys: stored.previous.length,
        };
    };

    return { deps, keysFile, domainsFile, attestationsFile, keys, document, me };
};

export const createS2sIdentity = (deps: IdentityDeps): S2sIdentity => {
    const core = createCore(deps);
    const current = async (): Promise<S2sKeySet> => keySetOf((await core.keys()).current);
    return {
        current,
        document: core.document,
        openWith: async () => {
            const stored = await core.keys();
            return [keySetOf(stored.current), ...stored.previous.map(keySetOf)];
        },
        sign: async (domain, bytes) => hybridSign(domain, bytes, secretKeysOf((await current()).secret)),
        addresses: async () => {
            const doc = await core.document();
            return [doc.host, ...doc.domains];
        },
        me: core.me,
        ...domainChanges(core),
        ...keyChanges(core),
        ...attestationChanges(core),
    };
};
