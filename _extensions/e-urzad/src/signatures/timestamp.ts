import * as asn1js from "asn1js";
import { Certificate, ContentInfo, RelativeDistinguishedNames, SignedData, SignedDataVerifyError, TSTInfo } from "pkijs";
import { formatName } from "./certificate.js";
import { toArrayBuffer } from "./engine.js";
import { TRUST_NOT_CHECKED, type TimestampFacts, type TrustFacts, trustSkipped } from "./report.js";

// RFC 3161 time-stamp tokens: a CMS SignedData by a TSA whose content (TSTInfo) carries the time and a hash of what was
// stamped. PKI.js checks both halves in one call: the message imprint against the bytes we hand it, and the TSA's
// signature over the TSTInfo.

const SIGNED_DATA = "1.2.840.113549.1.7.2";

// Who decides whether a certificate is trusted. The verifier modules take one, so the trusted-list code (trust/) stays
// out of the cryptography and a run with no cached list says "not checked" instead of guessing.
export interface TrustEvaluator {
    evaluate(certificate: Certificate, bundle: readonly Certificate[], at: Date | undefined, purpose: "signer" | "timestamp"): Promise<TrustFacts>;
}

export const NO_TRUST_LIST: TrustEvaluator = {
    evaluate: () => Promise.resolve(TRUST_NOT_CHECKED),
};

export const signedDataOf = (bytes: Uint8Array): SignedData => {
    const info = ContentInfo.fromBER(toArrayBuffer(bytes));
    if (info.contentType !== SIGNED_DATA) {
        throw new Error(`not CMS SignedData (content type ${info.contentType})`);
    }
    return new SignedData({ schema: info.content });
};

export const bundleOf = (signed: SignedData): Certificate[] => (signed.certificates ?? []).filter((entry): entry is Certificate => entry instanceof Certificate);

const tsaName = (signer: Certificate | null | undefined, info: TSTInfo | undefined): string | undefined => {
    if (signer !== null && signer !== undefined) {
        return formatName(signer.subject);
    }
    // GeneralName: a directoryName is a distinguished name, the other forms a string (a URI, a DNS name).
    const name: unknown = info?.tsa?.value;
    if (name instanceof RelativeDistinguishedNames) {
        return formatName(name);
    }
    return name === undefined || name === null ? undefined : String(name);
};

// The TSTInfo, with the eContent made a primitive OCTET STRING when a TSA sent it constructed (in pieces): PKI.js's
// token check reads only the primitive form, and the bytes, hence the signed message digest, are the same.
const tstInfoOf = (signed: SignedData): TSTInfo => {
    const content = signed.encapContentInfo.eContent;
    if (!(content instanceof asn1js.OctetString)) {
        throw new Error("no TSTInfo content");
    }
    const value = content.getValue();
    signed.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: value });
    return TSTInfo.fromBER(value);
};

// One token, checked against the exact bytes it should have stamped (a signature value, a document's signed ranges, a
// canonicalised XML element). `imprinted` undefined means the stamped bytes could not be reconstructed here: the time is
// reported, the imprint is not claimed.
export const verifyTimestamp = async (
    token: Uint8Array,
    imprinted: Uint8Array | undefined,
    kind: TimestampFacts["kind"],
    trust: TrustEvaluator,
): Promise<TimestampFacts> => {
    let signed: SignedData;
    let info: TSTInfo;
    try {
        signed = signedDataOf(token);
        info = tstInfoOf(signed);
    } catch (error) {
        return { kind, integrity: "not-checked", detail: `unreadable time-stamp token: ${error instanceof Error ? error.message : "malformed"}`, trust: trustSkipped("the time-stamp token could not be read") };
    }
    const time = info.genTime.toISOString();
    if (imprinted === undefined) {
        return { kind, time, integrity: "not-checked", detail: "the stamped bytes could not be reconstructed here, so the imprint was not compared", tsa: tsaName(undefined, info), trust: trustSkipped("the time-stamp was not verified") };
    }
    try {
        const result = await signed.verify({ signer: 0, data: toArrayBuffer(imprinted), checkChain: false, extendedMode: true });
        const signer = result.signerCertificate ?? undefined;
        const verdict: TrustFacts = signer === undefined ? trustSkipped("the time-stamp carries no TSA certificate") : await trust.evaluate(signer, bundleOf(signed), info.genTime, "timestamp");
        return {
            kind,
            time,
            integrity: result.signatureVerified === true ? "valid" : "invalid",
            detail: result.signatureVerified === true ? "imprint matches and the TSA signature verifies" : "the TSA signature does not verify",
            tsa: tsaName(signer, info),
            trust: verdict,
        };
    } catch (error) {
        const reason = error instanceof SignedDataVerifyError ? error.message : error instanceof Error ? error.message : "verification failed";
        const imprintBroken = /TSTInfo verification is failed|digest/i.test(reason);
        return { kind, time, integrity: imprintBroken ? "invalid" : "not-checked", detail: imprintBroken ? "the time-stamp does not cover these bytes" : reason, tsa: tsaName(undefined, info), trust: trustSkipped("the time-stamp did not verify") };
    }
};
