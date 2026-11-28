import type {
    S2sAttestation,
    S2sAttestationAsk,
    S2sAttestationIssue,
    S2sAttestationRow,
    S2sAttestations,
    S2sClaims,
    S2sMessageSendOutcome,
} from "@intentic/sandbox-contract/schemas/s2s";
import { attestationText, S2sSandboxVouchSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { refuse } from "@intentic/contract-serve";
import { DEMO_DAEMON_ORIGIN } from "../../transport";
import { contactOf } from "./s2sContacts";
import { fingerprintOf, keysOf, SIG } from "./s2sIdentity";
import { receivedOf, sendAttestation } from "./s2sThreads";

// What other sandboxes vouched for this one and its identity carries (docs/architecture/messages.md, "Attestations"): a
// notary's vouch it carries now, and one from a partner that lapsed last month, listed with why. Adding the research
// sandbox's vouch from its thread, removing one, asking a contact and vouching for one write here and into the threads.
// Nothing is signed or checked: the keys and signatures only have the shapes the contract parses.

const DAY = 24 * 3_600_000;
const SHOP = new URL(DEMO_DAEMON_ORIGIN);

const vouchBy = (seed: string, name: string, address: string, claims: S2sClaims, issuedAgo: number, lapsesIn: number): S2sAttestation => ({
    v: 1,
    type: `sandbox-vouch`,
    issuer: { sandbox: seed.replaceAll(`-`, ``), address, fingerprint: fingerprintOf(seed), keys: keysOf(seed), name },
    subject: { sandbox: `acmeshop`, address: SHOP.hostname, fingerprint: fingerprintOf(`acme-shop#1`) },
    claims,
    issuedAt: Date.now() - issuedAgo,
    validUntil: Date.now() + lapsesIn,
    sig: SIG,
});

interface Held {
    readonly id: string;
    readonly attestation: S2sAttestation;
    readonly acceptedAt: number;
    readonly contact?: string;
    readonly message?: string;
}

const seed = (): Held[] => [
    {
        id: `notaryoffice0vouch0000000a`,
        attestation: vouchBy(`notary-office`, `Notary Office Gdańsk`, `notary.gdansk.example`, { kind: `organisation`, verifiedBy: `document`, country: `PL`, organisation: `Acme Shop sp. z o.o.` }, 40 * DAY, 325 * DAY),
        acceptedAt: Date.now() - 39 * DAY,
    },
    {
        id: `partnerlapsed0vouch000000b`,
        attestation: vouchBy(`billing-partners`, `billing-partners`, `billing.partners.example`, { kind: `organisation`, verifiedBy: `domain` }, 400 * DAY, -35 * DAY),
        acceptedAt: Date.now() - 399 * DAY,
    },
];

const held: Held[] = seed();
let minted = 0;

const rowOf = (each: Held): S2sAttestationRow => {
    const lapsed = (S2sSandboxVouchSchema.safeParse(each.attestation).data?.validUntil ?? 0) <= Date.now();
    const row: S2sAttestationRow = { id: each.id, attestation: each.attestation, acceptedAt: each.acceptedAt, verified: !lapsed, published: !lapsed };
    if (lapsed) {
        row.problem = `it lapsed at ${new Date(S2sSandboxVouchSchema.safeParse(each.attestation).data?.validUntil ?? 0).toISOString()}`;
    }
    if (each.contact !== undefined) {
        row.contact = each.contact;
    }
    if (each.message !== undefined) {
        row.message = each.message;
    }
    return row;
};

export const attestationsList = (): S2sAttestations => ({ attestations: held.toSorted((a, b) => b.acceptedAt - a.acceptedAt).map(rowOf) });

/** The vouch a contact's message carried, added to this identity. */
export const acceptAttestation = (message: string): S2sAttestations => {
    const received = receivedOf(message);
    if (received.direction !== `in` || received.kind !== `attestation.issued` || received.attestation === undefined) {
        refuse(`No attestation a contact sent is filed as message ${message}.`, 404);
    }
    if (!held.some((each) => each.message === message)) {
        minted += 1;
        held.push({ id: `added${String(minted).padStart(21, `0`)}`, attestation: received.attestation ?? refuse(`No attestation.`, 404), acceptedAt: Date.now(), contact: received.contact, message });
    }
    return attestationsList();
};

export const removeAttestation = (id: string): S2sAttestations => {
    const at = held.findIndex((each) => each.id === id);
    if (at < 0) {
        refuse(`No attestation ${id} is held here.`, 404);
    }
    held.splice(at, 1);
    return attestationsList();
};

export const askVouch = (ask: S2sAttestationAsk): S2sMessageSendOutcome =>
    sendAttestation(ask.contact, { kind: `attestation.request`, text: attestationText(ask.claims, ask.note), claims: ask.claims });

export const issueVouch = (issue: S2sAttestationIssue): S2sMessageSendOutcome => {
    const contact = contactOf(SHOP, issue.contact);
    const attestation: S2sAttestation = {
        v: 1,
        type: `sandbox-vouch`,
        issuer: { sandbox: `acmeshop`, address: SHOP.hostname, fingerprint: fingerprintOf(`acme-shop#1`), keys: keysOf(`acme-shop#1`), name: `acme-shop` },
        subject: { sandbox: contact.id, address: contact.address, fingerprint: contact.fingerprint },
        claims: issue.claims,
        issuedAt: Date.now(),
        validUntil: issue.validUntil,
        sig: SIG,
    };
    return sendAttestation(issue.contact, { kind: `attestation.issued`, text: attestationText(issue.claims, issue.note), claims: issue.claims, attestation }, issue.replyTo);
};
