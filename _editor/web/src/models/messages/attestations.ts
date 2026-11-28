import {
    S2S_ATTESTATION_VALID_MAX_MS,
    S2S_WELL_KNOWN_CLAIMS,
    type S2sAttestation,
    type S2sAttestationRow,
    type S2sClaims,
    S2sSandboxVouchSchema,
} from "@intentic/sandbox-contract/schemas/s2s";

// ATTESTATIONS as the Messages tab draws and writes them (docs/architecture/messages.md, "Attestations"): what a vouch
// says (who vouched, for what, until when), the claims form's fields and what they come to, and the valid-until date a
// person picks turned into the instant the daemon signs. Pure, so the Identity section, a contact and a thread agree.

const DAY_MS = 24 * 60 * 60 * 1000;
// A minute short of the year, so a date picked at the limit is still inside it when the daemon checks.
const MARGIN_MS = 60 * 1000;

export interface VouchFacts {
    // The issuer's name as its document gave it, else its address.
    readonly issuer: string;
    readonly address: string;
    readonly fingerprint: string;
    readonly claims: S2sClaims;
    readonly validUntil: number;
}

/** What a vouch says, or undefined for an attestation of a type this editor does not read. */
export const vouchFacts = (attestation: S2sAttestation): VouchFacts | undefined => {
    const vouch = S2sSandboxVouchSchema.safeParse(attestation).data;
    return vouch === undefined
        ? undefined
        : { issuer: vouch.issuer.name ?? vouch.issuer.address, address: vouch.issuer.address, fingerprint: vouch.issuer.fingerprint, claims: vouch.claims, validUntil: vouch.validUntil };
};

// One field of the claims form: a word typed, or a yes/no switched. Its key is the claim's own name.
export type ClaimField = { readonly key: string; readonly kind: `text`; text: string } | { readonly key: string; readonly kind: `yesNo`; checked: boolean };

const WELL_KNOWN: ReadonlySet<string> = new Set(S2S_WELL_KNOWN_CLAIMS);
const YES_NO: ReadonlySet<string> = new Set([`over18`]);

/** The form's fields for these claims: every well-known one (empty where unclaimed), then the others by their own key. */
export const fieldsFrom = (claims: S2sClaims = {}): ClaimField[] =>
    [...S2S_WELL_KNOWN_CLAIMS, ...Object.keys(claims).filter((key) => !WELL_KNOWN.has(key))].map((key): ClaimField => {
        const value = claims[key];
        return YES_NO.has(key) ? { key, kind: `yesNo`, checked: value === true } : { key, kind: `text`, text: value === undefined ? `` : String(value) };
    });

/** What the fields claim: a field left empty, or a switch left off, claims nothing. */
export const claimsFrom = (fields: readonly ClaimField[]): S2sClaims =>
    Object.fromEntries(
        fields.flatMap((field): [string, string | boolean][] => {
            if (field.kind === `yesNo`) {
                return field.checked ? [[field.key, true]] : [];
            }
            return field.text.trim() === `` ? [] : [[field.key, field.text.trim()]];
        }),
    );

// A date input's `YYYY-MM-DD`, on the reader's own calendar.
const dateOf = (at: number): string => {
    const day = new Date(at);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, `0`)}-${String(day.getDate()).padStart(2, `0`)}`;
};

/** The earliest date a vouch made now may run to: today, to its end. */
export const earliestUntilDate = (now: number): string => dateOf(now);

/** The latest date a vouch made now may run to, as a date input reads it. */
export const latestUntilDate = (now: number): string => dateOf(now + S2S_ATTESTATION_VALID_MAX_MS - MARGIN_MS);

/** The date a vouch form opens on: a year from now, the longest it may run. */
export const defaultUntilDate = (now: number): string => dateOf(now + S2S_ATTESTATION_VALID_MAX_MS - DAY_MS);

/** The instant a picked date stands for: the end of that day, held inside the year; undefined for no date or one already past. */
export const validUntilOf = (date: string, now: number): number | undefined => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
    if (match === null) {
        return undefined;
    }
    const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime() - 1;
    const held = Math.min(end, now + S2S_ATTESTATION_VALID_MAX_MS - MARGIN_MS);
    return held > now ? held : undefined;
};

/** Whether a thread's `attestation.issued` message is the one a row of the identity came from. */
export const carriedFrom = (rows: readonly S2sAttestationRow[], message: string): S2sAttestationRow | undefined => rows.find((row) => row.message === message);
