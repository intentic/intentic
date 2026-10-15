// What a verification says, one entry per signature found. Three questions are kept apart on purpose, because the
// whole point of the report is not to let one stand in for another:
// - integrity: do the signature value and the digests match the bytes they cover, under the key of the certificate the
//   signature names? A cryptographic fact about this file.
// - trust: does that certificate chain to a service on the EU trusted list, and was the service granted when it signed?
//   Answered only when a trusted list is cached (`e-urzad trust refresh`); otherwise "not-checked", said plainly.
// - qualification: whether the certificate CLAIMS qualified status (QcStatements) is a fact about the certificate;
//   whether the signature IS a qualified electronic signature needs trust, revocation and the device as well. This
//   verifier never says it is: at best it says the indications are there and what was not checked.

export type Integrity = "valid" | "invalid" | "not-checked";

export type SignatureFormat = "CAdES" | "PAdES" | "XAdES" | "CMS" | "XMLDSig" | "PDF timestamp" | "unknown";

export interface SubjectFields {
    readonly commonName?: string;
    readonly givenName?: string;
    readonly surname?: string;
    readonly serialNumber?: string;
    readonly organization?: string;
    readonly organizationIdentifier?: string;
    readonly country?: string;
    readonly email?: string;
}

export interface QcClaims {
    // QcCompliance (0.4.0.1862.1.1): the issuer states this is an EU qualified certificate.
    readonly compliance: boolean;
    // QcSSCD (0.4.0.1862.1.4): the issuer states the private key sits in a qualified signature/seal creation device.
    readonly qscd: boolean;
    // QcType (0.4.0.1862.1.6): esign (natural person), eseal (legal person), web.
    readonly types: readonly string[];
    // QcCClegislation: a qualified certificate under another country's law, when present.
    readonly legislation: readonly string[];
    // Every statement id present, recognised or not.
    readonly statements: readonly string[];
}

export interface CertificateFacts {
    readonly subject: string;
    readonly subjectFields: SubjectFields;
    // The 11 digits when the subject's serialNumber carries a Polish national number (PNOPL-…, PESEL:…) with a valid
    // check digit. Personal data: shown because the owner asked who signed, never logged.
    readonly pesel?: string;
    readonly issuer: string;
    readonly serialNumber: string;
    readonly validFrom: string;
    readonly validTo: string;
    readonly sha256: string;
    readonly qc: QcClaims;
    // Certificate policy OIDs, with the ETSI EN 319 411-2 ones named (QCP-n-qscd and so on).
    readonly policies: readonly string[];
}

export interface TimestampFacts {
    readonly kind: "signature-timestamp" | "document-timestamp" | "content-timestamp" | "archive-timestamp";
    readonly time?: string;
    readonly integrity: Integrity;
    readonly detail: string;
    readonly tsa?: string;
    readonly trust: TrustFacts;
}

export type TrustStatus = "not-checked" | "anchored" | "not-anchored" | "chain-invalid";

export interface TrustFacts {
    readonly status: TrustStatus;
    readonly detail: string;
    // The trusted-list service the chain ends at, when anchored.
    readonly service?: {
        readonly name: string;
        readonly provider: string;
        readonly territory: string;
        readonly type: string;
        // The service's status at the time the chain was checked for (signing time when known, else now).
        readonly status: string;
        readonly qualifiers: readonly string[];
    };
    // Revocation (OCSP/CRL) is never consulted by this verifier.
    readonly revocation: "not-checked";
    readonly checkedAt?: string;
    readonly trustedList?: string;
}

export interface SigningTime {
    readonly value: string;
    // Where the time came from: a signed attribute is part of what was signed, a PDF /M entry is not.
    readonly source: "cms-signing-time" | "xades-signing-time" | "pdf-dictionary";
}

export interface SignatureFacts {
    readonly index: number;
    readonly format: SignatureFormat;
    readonly integrity: Integrity;
    readonly integrityDetail: string;
    // What the signature covers: the detached file, the XML references, the PDF byte ranges.
    readonly scope: string;
    readonly signer?: CertificateFacts;
    // Whether the signed attributes bind the signer certificate (ESS signing-certificate(-v2), XAdES SigningCertificate),
    // which stops a certificate swap behind the same key; undefined when the format carries no such binding.
    readonly signerBound?: boolean;
    readonly signingTime?: SigningTime;
    readonly timestamps: readonly TimestampFacts[];
    readonly trust: TrustFacts;
    readonly qualification: string;
    readonly notes: readonly string[];
}

export interface VerificationReport {
    readonly file: string;
    readonly detected: SignatureFormat;
    readonly signatures: readonly SignatureFacts[];
    // Present when nothing could be verified at all: an unsupported file, a parse failure.
    readonly problem?: string;
    readonly summary: string;
}

export const TRUST_NOT_CHECKED: TrustFacts = {
    status: "not-checked",
    detail: "trust chain not checked: no EU trusted list is cached here (run `e-urzad trust refresh` to fetch and verify one)",
    revocation: "not-checked",
};

// "Not checked" for a reason other than a missing list: the signature or time-stamp itself did not verify, so there is
// nothing whose certificate a trust answer would be about.
export const trustSkipped = (reason: string): TrustFacts => ({ status: "not-checked", detail: `trust chain not checked: ${reason}`, revocation: "not-checked" });

// The statuses under which a CA/QC service issued qualified certificates: "granted" since eIDAS (1 July 2016), and the
// TS 119 612 v1 statuses a list's history still carries for the years before it.
const QUALIFIED_STATUSES = ["/granted", "/accredited", "/undersupervision", "/supervisionincessation"];

export const qualificationOf = (integrity: Integrity, signer: CertificateFacts | undefined, trust: TrustFacts): string => {
    if (integrity !== "valid") {
        return "not established: the signature does not verify";
    }
    if (signer === undefined || !signer.qc.compliance) {
        return "not established: the certificate does not claim qualified status (no QcCompliance)";
    }
    const device = signer.qc.qscd || (trust.service?.qualifiers ?? []).some((qualifier) => qualifier.endsWith("QCWithSSCD") || qualifier.endsWith("QCWithQSCD"));
    if (trust.status !== "anchored") {
        return `not established: the certificate claims qualified status${device ? " on a qualified device" : ""}, but the trust chain was not confirmed (${trust.status})`;
    }
    const status = trust.service?.status ?? "";
    const qualifiedService = trust.service?.type.endsWith("/CA/QC") === true && QUALIFIED_STATUSES.some((suffix) => status.endsWith(suffix));
    if (!qualifiedService) {
        return "not established: the chain ends at a trusted-list service that was not a qualified CA (CA/QC) in good standing at that time";
    }
    return device
        ? "indicated, not confirmed: qualified certificate claim, QSCD claim and a chain to a granted CA/QC service; revocation was not checked, so this is not a full qualified-signature validation"
        : "indicated for a qualified certificate only: no QSCD claim, so at most an advanced signature with a qualified certificate; revocation not checked";
};

export const summaryOf = (signatures: readonly SignatureFacts[]): string => {
    if (signatures.length === 0) {
        return "no signature found";
    }
    const valid = signatures.filter((signature) => signature.integrity === "valid").length;
    const invalid = signatures.filter((signature) => signature.integrity === "invalid").length;
    const anchored = signatures.filter((signature) => signature.trust.status === "anchored").length;
    const trust = anchored === 0 ? "trust chain not checked or not confirmed" : `${anchored} anchored in the EU trusted list (revocation not checked)`;
    return `${signatures.length} signature(s): ${valid} intact, ${invalid} broken, ${signatures.length - valid - invalid} not checkable; ${trust}`;
};
