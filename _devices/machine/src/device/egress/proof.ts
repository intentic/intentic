import { createHash } from "node:crypto";
import { parseJsonWith } from "@intentic/base/json";
import { base64url, verifyAuthentication, WebAuthnError } from "@intentic/base/webauthn";
import {
    canonicalEgressOwnerKeysJson,
    canonicalEgressPolicy,
    canonicalEgressPolicyJson,
    EGRESS_HOST,
    EGRESS_PROOF_MAX_AGE_MS,
    type EgressAllow,
    EgressChangeDocumentSchema,
    type EgressOwnerKeys,
    type EgressPolicy,
    type EgressProof,
} from "@intentic/sandbox-contract/schemas/egress";
import type { EgressPin } from "./pins.js";

/* WHETHER THE OWNER'S PASSKEY SIGNED EXACTLY THIS LOOSENING (2026-10-27). Pure over what it is handed: the signed
   document text, the assertion, the change asked for, what ic holds now, this agent's own identity, the pin, and the
   clock. Every refusal is an EgressRefusal whose message is the sentence the owner reads on the card. */

export class EgressRefusal extends Error {}

const sha256 = (bytes: string | Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const sha256Hex = (text: string): string => sha256(Buffer.from(text, "utf8")).toString("hex");

// The challenge the editor hands the passkey: the sha256 of the document's text, base64url.
export const egressChallengeOf = (documentText: string): string => base64url.encode(sha256(Buffer.from(documentText, "utf8")));

// The hex digest a signed change names as `keys`.
export const ownerKeysDigest = (owner: EgressOwnerKeys): string => sha256Hex(canonicalEgressOwnerKeysJson(owner));

// One exception as a person reads it: `192.168.1.20 port 445/tcp`, `the machine itself`.
const reachText = (entry: EgressAllow): string => {
    const where = entry.to === EGRESS_HOST ? "the machine itself" : entry.to;
    const ports = entry.ports === undefined ? "" : ` port${entry.ports.length === 1 ? "" : "s"} ${entry.ports.join(", ")}`;
    const protocol = entry.protocol === undefined ? "" : ports === "" ? ` (${entry.protocol} only)` : `/${entry.protocol}`;
    return `${where}${ports}${protocol}`;
};

// What a loosening opens, for the sentence that asks for the passkey. Pure.
export const looseningText = (slug: string, from: EgressPolicy, to: EgressPolicy): string => {
    if (to.profile === "open") {
        return `this change turns the egress fence of "${slug}" off, so it reaches your network and this machine again`;
    }
    const reach = (entry: EgressAllow): string => JSON.stringify([entry.to, entry.ports ?? null, entry.protocol ?? null]);
    const before = new Set(canonicalEgressPolicy(from).allow.map(reach));
    const opened = canonicalEgressPolicy(to).allow.filter((entry) => !before.has(reach(entry)));
    return opened.length === 0
        ? `this change loosens the egress fence of "${slug}"`
        : `this change opens ${opened.map(reachText).join(", ")} to "${slug}"`;
};

export interface ProofCheck {
    readonly proof: EgressProof;
    readonly slug: string;
    // The policy asked for, and the revision ic holds now.
    readonly asked: EgressPolicy;
    readonly revision: string;
    readonly machineId: string;
    readonly environment: string;
    // What the daemon filled in, when it did.
    readonly ownerKeys: EgressOwnerKeys | undefined;
    readonly pin: EgressPin;
    readonly now: number;
}

export interface VerifiedProof {
    // The pinned key that signed, and the counter it reported.
    readonly keyId: string;
    readonly counter: number;
    // The daemon-filled owner keys are the ones the signature names, so the pin may move to them.
    readonly ownerKeysSigned: boolean;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;

// The document's own claims against this machine, this sandbox, this change and this moment.
const checkDocument = (check: ProofCheck): string => {
    const document = parseJsonWith(check.proof.document, EgressChangeDocumentSchema);
    if (document === undefined) {
        throw new EgressRefusal("What your passkey signed is not an intentic egress change this agent can read (v1, intentic-egress-change). Sign the change again.");
    }
    if (document.machineId !== check.machineId) {
        throw new EgressRefusal(`The change you signed is for another machine (${document.machineId}), not this one (${check.machineId}). Sign it again for this machine.`);
    }
    if (document.environment !== check.environment) {
        throw new EgressRefusal(
            `The change you signed is for another side of this computer (${document.environment}); this agent is ${check.environment}. Sign it again from the sandbox's own row.`,
        );
    }
    if (document.slug !== check.slug) {
        throw new EgressRefusal(`The change you signed is for sandbox "${document.slug}", not "${check.slug}". Sign the change for "${check.slug}".`);
    }
    if (document.basedOn !== check.revision) {
        throw new EgressRefusal(`The egress policy of "${check.slug}" changed since you signed. Look at it again and sign again.`);
    }
    if (canonicalEgressPolicyJson(document.policy) !== canonicalEgressPolicyJson(check.asked)) {
        throw new EgressRefusal(`The policy you signed is not the one this request asks for on "${check.slug}". Sign the change again.`);
    }
    if (document.expiresAt <= check.now) {
        throw new EgressRefusal(`Your signature over this change expired (a signed change holds for ${minutes(EGRESS_PROOF_MAX_AGE_MS)}). Sign again.`);
    }
    if (document.expiresAt > check.now + EGRESS_PROOF_MAX_AGE_MS) {
        throw new EgressRefusal(
            `The signed change says it holds until ${new Date(document.expiresAt).toISOString()}, more than ${minutes(EGRESS_PROOF_MAX_AGE_MS)} ahead of this machine's clock. Check the clocks of this machine and the device you signed on, then sign again.`,
        );
    }
    if (check.ownerKeys !== undefined && document.keys !== ownerKeysDigest(check.ownerKeys)) {
        throw new EgressRefusal("The passkeys this request carries are not the ones you signed over. Reload the page and sign again.");
    }
    return document.keys;
};

export const verifyEgressProof = (check: ProofCheck): VerifiedProof => {
    const signedKeys = checkDocument(check);
    const { assertion } = check.proof;
    const key = check.pin.owner.keys.find((pinned) => pinned.id === assertion.id);
    if (key === undefined || assertion.rawId !== assertion.id) {
        const names = check.pin.owner.keys.map((pinned) => pinned.name ?? pinned.id).join(", ");
        throw new EgressRefusal(
            `The passkey you signed with is not one this machine pinned for "${check.slug}"${names === "" ? "" : ` (it trusts ${names})`}. Sign with one of those, or change it on the machine itself with \`ic sandbox egress ${check.slug}\`.`,
        );
    }
    const counter = check.pin.counters[key.id] ?? 0;
    try {
        const verified = verifyAuthentication(assertion, {
            challenge: egressChallengeOf(check.proof.document),
            origin: check.pin.owner.origins,
            rpId: check.pin.owner.rpId,
            publicKey: { alg: key.alg, jwk: key.jwk },
            counter,
        });
        return { keyId: key.id, counter: verified.counter, ownerKeysSigned: check.ownerKeys !== undefined && signedKeys === ownerKeysDigest(check.ownerKeys) };
    } catch (error) {
        if (error instanceof WebAuthnError) {
            throw new EgressRefusal(`Your passkey's signature over this change did not check out on this machine: ${error.message}. Sign again.`);
        }
        throw error;
    }
};
