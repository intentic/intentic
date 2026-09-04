import type { TranscriptCredentialOffer } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { credentialLane, offerStatus } from "./cardStatus";

/* THE RELEASE CARD's two derivations. `offerStatus` is shared with the two spend cards and needs pinning only
 * where the credential card could drift from them; `credentialLane` is the sentence an approver actually reads
 * before deciding, so it is the one piece of this card's prose worth a test. */

const offer = (over: Partial<TranscriptCredentialOffer[`offer`]> = {}): TranscriptCredentialOffer[`offer`] => ({
    subject: `DATABASE_URL`,
    kind: `secret`,
    lane: `shell`,
    approvers: [`bob@corp.com`],
    scope: `use`,
    ...over,
});

const card = (over: Partial<TranscriptCredentialOffer> = {}): TranscriptCredentialOffer => ({
    requestId: `c1`,
    offer: offer(),
    status: `pending`,
    ...over,
});

it(`reads a release the way it reads a spend: approved, skipped, or nobody answered`, () => {
    expect(offerStatus(card({ status: `pending` }))).toBeUndefined();
    expect(offerStatus(card({ status: `approved` }))).toEqual({ label: `Approved`, tone: `done` });
    expect(offerStatus(card({ status: `skipped` }))).toEqual({ label: `Skipped`, tone: `gone` });
    // A turn that died under the card is not a decision anybody made, so it must not read as a refusal.
    expect(offerStatus(card({ status: `cancelled` }))).toEqual({ label: `Not answered`, tone: `gone` });
});

it(`says what the release is FOR, in the terms the person deciding thinks in`, () => {
    /* The lane name is the daemon's word and decides nothing for a reader: what decides it is where the
     * credential is about to go, and a password typed into a page is a different risk from an account being
     * loaded for a turn. */
    expect(credentialLane(offer({ lane: `shell` }))).toContain(`shell command`);
    expect(credentialLane(offer({ lane: `code` }))).toContain(`script`);
    expect(credentialLane(offer({ lane: `browser` }))).toContain(`type it into a page`);
    expect(credentialLane(offer({ lane: `otp` }))).toContain(`one-time code`);
    // Each lane says something different: a card whose sentence does not repay reading trains people to skip it.
    const lanes = ([`shell`, `code`, `browser`, `otp`] as const).map((lane) => credentialLane(offer({ lane })));
    expect(new Set(lanes).size).toBe(lanes.length);
});

it(`names a mounted account as being loaded rather than used, because that is what happens to it`, () => {
    // `session` is the whole capability coming into the turn, which is the one lane whose wording depends on
    // the kind: a secret is never mounted, it is spent at an exit.
    expect(credentialLane(offer({ lane: `session`, kind: `capability` }))).toContain(`loaded into the conversation`);
    expect(credentialLane(offer({ lane: `session`, kind: `secret` }))).toBe(`The agent is asking to use this credential.`);
});
