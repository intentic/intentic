import * as asn1js from "asn1js";
import { type Attribute, type Certificate, type SignedData, SignedDataVerifyError, type SignerInfo } from "pkijs";
import { certificateFacts, derOf } from "./certificate.js";
import { digest, hashNameOf, sameBytes, toArrayBuffer } from "./engine.js";
import { type Integrity, type SignatureFacts, type SignatureFormat, type SigningTime, type TimestampFacts, qualificationOf, trustSkipped } from "./report.js";
import { bundleOf, signedDataOf, type TrustEvaluator, verifyTimestamp } from "./timestamp.js";

// CAdES and plain CMS (PKCS#7) signatures: .p7s/.sig detached beside the file they sign, .p7m enveloping it, and the
// CMS inside every PDF signature (pdf.ts). PKI.js recomputes the message digest over the content and checks the
// signature value under the signer certificate's key; this module adds the CAdES parts PKI.js leaves to its caller.

const SIGNING_TIME = "1.2.840.113549.1.9.5";
const SIGNING_CERTIFICATE = "1.2.840.113549.1.9.16.2.12";
const SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
const SIGNATURE_TIMESTAMP = "1.2.840.113549.1.9.16.2.14";
const SHA256 = "2.16.840.1.101.3.4.2.1";
const SHA1 = "1.3.14.3.2.26";

export interface CmsInput {
    readonly bytes: Uint8Array;
    // The signed file for a detached signature; ignored when the CMS encloses its content.
    readonly detached?: Uint8Array | undefined;
    readonly format: "CAdES" | "PAdES";
    readonly scope: string;
    readonly trust: TrustEvaluator;
    // Extra lines the caller wants on every signature (a PDF revision note).
    readonly notes?: readonly string[];
}

const attribute = (attributes: readonly Attribute[] | undefined, type: string): Attribute | undefined => attributes?.find((entry) => entry.type === type);

const signingTimeOf = (signer: SignerInfo): SigningTime | undefined => {
    const value = attribute(signer.signedAttrs?.attributes, SIGNING_TIME)?.values[0];
    if (value instanceof asn1js.UTCTime || value instanceof asn1js.GeneralizedTime) {
        return { value: value.toDate().toISOString(), source: "cms-signing-time" };
    }
    return undefined;
};

// ESS signing-certificate(-v2): SEQUENCE { certs SEQUENCE OF ESSCertID(v2), … }, where ESSCertIDv2 is
// { hashAlgorithm AlgorithmIdentifier DEFAULT sha256, certHash OCTET STRING, issuerSerial OPTIONAL } and the v1
// ESSCertID is { certHash OCTET STRING (SHA-1), issuerSerial OPTIONAL }. The first entry names the signer's certificate.
const essCertId = (signer: SignerInfo): { readonly hash: string; readonly value: Uint8Array } | undefined => {
    const v2 = attribute(signer.signedAttrs?.attributes, SIGNING_CERTIFICATE_V2);
    const v1 = attribute(signer.signedAttrs?.attributes, SIGNING_CERTIFICATE);
    const value = (v2 ?? v1)?.values[0];
    const certs = value instanceof asn1js.Sequence ? value.valueBlock.value[0] : undefined;
    const first = certs instanceof asn1js.Sequence ? certs.valueBlock.value[0] : undefined;
    if (!(first instanceof asn1js.Sequence)) {
        return undefined;
    }
    const [head, next] = first.valueBlock.value;
    if (head instanceof asn1js.OctetString) {
        return { hash: v2 === undefined ? SHA1 : SHA256, value: head.valueBlock.valueHexView };
    }
    const algorithm = head instanceof asn1js.Sequence ? head.valueBlock.value[0] : undefined;
    if (algorithm instanceof asn1js.ObjectIdentifier && next instanceof asn1js.OctetString) {
        return { hash: algorithm.valueBlock.toString(), value: next.valueBlock.valueHexView };
    }
    return undefined;
};

const signerBinding = async (signer: SignerInfo, certificate: Certificate): Promise<boolean | undefined> => {
    const id = essCertId(signer);
    if (id === undefined) {
        return undefined;
    }
    const hash = hashNameOf(id.hash);
    return hash === undefined ? false : sameBytes(await digest(hash, derOf(certificate)), id.value);
};

const timestampsOf = async (signer: SignerInfo, trust: TrustEvaluator): Promise<TimestampFacts[]> => {
    const tokens = attribute(signer.unsignedAttrs?.attributes, SIGNATURE_TIMESTAMP)?.values ?? [];
    const stamped = signer.signature.valueBlock.valueHexView;
    return Promise.all(tokens.map((token) => verifyTimestamp(new Uint8Array(token.toBER(false)), stamped, "signature-timestamp", trust)));
};

interface Checked {
    readonly integrity: Integrity;
    readonly detail: string;
    readonly certificate?: Certificate | undefined;
}

// PKI.js reports a failed check as a thrown SignedDataVerifyError with a code; 15 is a content digest that does not
// match, 2/3 a signer certificate that is not in the bundle, 4/8 detached content that was not supplied.
const checkSignature = async (signed: SignedData, index: number, detached: Uint8Array | undefined): Promise<Checked> => {
    try {
        const result = await signed.verify({ signer: index, data: detached === undefined ? new ArrayBuffer(0) : toArrayBuffer(detached), checkChain: false, extendedMode: true });
        return result.signatureVerified === true
            ? { integrity: "valid", detail: "content digest and signature value match the signer certificate's key", certificate: result.signerCertificate ?? undefined }
            : { integrity: "invalid", detail: "the signature value does not verify under the signer certificate's key", certificate: result.signerCertificate ?? undefined };
    } catch (error) {
        if (!(error instanceof SignedDataVerifyError)) {
            return { integrity: "not-checked", detail: error instanceof Error ? error.message : "verification failed" };
        }
        const certificate = error.signerCertificate ?? undefined;
        if (error.code === 15) {
            return { integrity: "invalid", detail: "the signed content was changed: its digest no longer matches the signed message-digest", certificate };
        }
        if (error.code === 2 || error.code === 3) {
            return { integrity: "not-checked", detail: "the signer's certificate is not included, so the signature cannot be checked", certificate };
        }
        if (error.code === 4 || error.code === 8) {
            return { integrity: "not-checked", detail: "detached signature: pass the signed file as well (e-urzad verify SIGNATURE --content FILE)", certificate };
        }
        return { integrity: "not-checked", detail: error.message, certificate };
    }
};

const formatOf = (input: CmsInput, signer: SignerInfo): SignatureFormat => {
    if (input.format === "PAdES") {
        return "PAdES";
    }
    const bound = attribute(signer.signedAttrs?.attributes, SIGNING_CERTIFICATE_V2) ?? attribute(signer.signedAttrs?.attributes, SIGNING_CERTIFICATE);
    return bound === undefined ? "CMS" : "CAdES";
};

const enclosedLength = (signed: SignedData): number => {
    const content = signed.encapContentInfo.eContent;
    return content instanceof asn1js.OctetString ? content.getValue().byteLength : 0;
};

const verifySigner = async (input: CmsInput, signed: SignedData, index: number, signer: SignerInfo): Promise<SignatureFacts> => {
    const detached = signed.encapContentInfo.eContent === undefined ? input.detached : undefined;
    const checked = await checkSignature(signed, index, detached);
    const timestamps = await timestampsOf(signer, input.trust);
    const signingTime = signingTimeOf(signer);
    const certificate = checked.certificate;
    const signerFacts = certificate === undefined ? undefined : await certificateFacts(certificate);
    // A time-stamp is evidence of when the signature existed; the signing-time attribute is the signer's own claim.
    const at = timestamps.find((stamp) => stamp.integrity === "valid")?.time ?? signingTime?.value;
    const trust = certificate === undefined ? trustSkipped("the signer's certificate is not in the signature") : await input.trust.evaluate(certificate, bundleOf(signed), at === undefined ? undefined : new Date(at), "signer");
    return {
        index,
        format: formatOf(input, signer),
        integrity: checked.integrity,
        integrityDetail: checked.detail,
        scope: signed.encapContentInfo.eContent === undefined ? input.scope : `the content enclosed in the signature (${enclosedLength(signed)} bytes)`,
        signer: signerFacts,
        signerBound: certificate === undefined ? undefined : await signerBinding(signer, certificate),
        signingTime,
        timestamps,
        trust,
        qualification: qualificationOf(checked.integrity, signerFacts, trust),
        notes: input.notes ?? [],
    };
};

export const verifyCms = async (input: CmsInput): Promise<SignatureFacts[]> => {
    const signed = signedDataOf(input.bytes);
    return Promise.all(signed.signerInfos.map((signer, index) => verifySigner(input, signed, index, signer)));
};

// The enclosed content of an enveloping signature (.p7m), so the caller can save what was signed.
export const enclosedContent = (bytes: Uint8Array): Uint8Array | undefined => {
    const content = signedDataOf(bytes).encapContentInfo.eContent;
    return content instanceof asn1js.OctetString ? new Uint8Array(content.getValue()) : undefined;
};
