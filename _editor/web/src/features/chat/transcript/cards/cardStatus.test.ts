import type { TranscriptCredentialOffer } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { credentialLane, offerStatus } from "./cardStatus";

// Pins offerStatus only where the credential card could drift from the shared spend-card logic, and credentialLane, the
// prose an approver actually reads.

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
    expect(offerStatus(card({ status: `cancelled` }))).toEqual({ label: `Not answered`, tone: `gone` });
});

it(`says what the release is FOR, in the terms the person deciding thinks in`, () => {
    expect(credentialLane(offer({ lane: `shell` }))).toContain(`shell command`);
    expect(credentialLane(offer({ lane: `code` }))).toContain(`script`);
    expect(credentialLane(offer({ lane: `browser` }))).toContain(`type it into a page`);
    expect(credentialLane(offer({ lane: `otp` }))).toContain(`one-time code`);
    const lanes = ([`shell`, `code`, `browser`, `otp`] as const).map((lane) => credentialLane(offer({ lane })));
    expect(new Set(lanes).size).toBe(lanes.length);
});

it(`names a mounted account as being loaded rather than used, because that is what happens to it`, () => {
    expect(credentialLane(offer({ lane: `session`, kind: `capability` }))).toContain(`loaded into the conversation`);
    expect(credentialLane(offer({ lane: `session`, kind: `secret` }))).toBe(`The agent is asking to use this credential.`);
});
