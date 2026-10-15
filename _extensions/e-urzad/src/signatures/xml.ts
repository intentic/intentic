import { Parse } from "xadesjs";
import { CryptoConfig, SignedXml, X509Certificate, XmlCanonicalizer } from "xmldsigjs";
import { certificateFacts, derOf, parseCertificate } from "./certificate.js";
import { descendants, isElement } from "./dom.js";
import { causeText, digest, hashNameOf, sameBytes, toArrayBuffer } from "./engine.js";
import { type Integrity, qualificationOf, type SignatureFacts, type SigningTime, type TimestampFacts, trustSkipped } from "./report.js";
import { type TrustEvaluator, verifyTimestamp } from "./timestamp.js";

// XAdES (and bare XMLDSig): .xml and .xades, enveloped, enveloping or detached. xadesjs (over xmldsigjs) recomputes every
// Reference digest and checks the SignatureValue; this module decides WHICH key it checks against (the certificate the
// report names, never a KeyValue an attacker could add beside it), supplies the detached file for external references,
// and reads the XAdES properties: whether the SignedProperties are actually signed, the SigningCertificate binding, the
// signing time and signature time-stamps.

const DS = "http://www.w3.org/2000/09/xmldsig#";
const XADES_TYPES = new Set(["http://uri.etsi.org/01903#SignedProperties", "http://uri.etsi.org/01903/v1.3.2#SignedProperties"]);
const C14N_EXCLUSIVE = "http://www.w3.org/2001/10/xml-exc-c14n#";
const C14N_DEFAULT = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

export interface XmlInput {
    readonly bytes: Uint8Array;
    readonly detached?: Uint8Array | undefined;
    readonly detachedName?: string | undefined;
    readonly trust: TrustEvaluator;
}

const elements = descendants;

const first = (root: Element, localName: string): Element | undefined => elements(root, localName)[0];

const text = (element: Element | undefined): string => element?.textContent?.replaceAll(/\s/g, "") ?? "";

export const parseXml = (bytes: Uint8Array): Document => {
    const source = Buffer.from(bytes).toString("utf8");
    // No DTDs: entity expansion is how an XML file attacks its reader, and a signed document has no use for one.
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
        throw new Error("XML with a DTD or entity declarations is refused");
    }
    // xml-core's Parse, over the xmldom parser engine.ts registers: the Document type xadesjs itself takes.
    const document = Parse(source);
    if (document.documentElement === null || document.getElementsByTagName("parsererror").length > 0) {
        throw new Error("malformed XML");
    }
    return document;
};

interface ReferenceFacts {
    readonly uri: string;
    readonly type: string;
}

const referencesOf = (signature: Element): ReferenceFacts[] =>
    elements(first(signature, "SignedInfo") ?? signature, "Reference").map((reference) => ({ uri: reference.getAttribute("URI") ?? "", type: reference.getAttribute("Type") ?? "" }));

const external = (reference: ReferenceFacts): boolean => reference.uri !== "" && !reference.uri.startsWith("#");

const describeReference = (reference: ReferenceFacts, document: Document): string => {
    if (reference.uri === "") {
        return "the whole document (enveloped)";
    }
    if (external(reference)) {
        return `the file "${reference.uri}" (detached)`;
    }
    const id = reference.uri.slice(1);
    const target = Array.from(document.getElementsByTagName("*")).find((element) => ["Id", "ID", "id"].some((name) => element.getAttribute(name) === id));
    return XADES_TYPES.has(reference.type) ? "the XAdES signed properties" : `element <${target?.localName ?? "?"}> #${id}`;
};

// Whether a Reference covers the SignedProperties element: without one the signing time and certificate binding in
// them are unsigned claims and the signature is plain XMLDSig.
const signedPropertiesOf = (signature: Element, references: readonly ReferenceFacts[]): Element | undefined => {
    const properties = first(signature, "SignedProperties");
    const id = properties?.getAttribute("Id") ?? properties?.getAttribute("ID") ?? undefined;
    return id !== undefined && references.some((reference) => reference.uri === `#${id}`) ? properties : undefined;
};

const signerCertificateOf = (signature: Element): Uint8Array | undefined => {
    const encoded = text(first(first(signature, "KeyInfo") ?? signature, "X509Certificate"));
    return encoded === "" ? undefined : new Uint8Array(Buffer.from(encoded, "base64"));
};

// SigningCertificate (XAdES 1.3.2) or SigningCertificateV2 (EN 319 132): a digest of the signer's certificate inside the
// signed properties.
const boundTo = async (properties: Element | undefined, certificate: Uint8Array): Promise<boolean | undefined> => {
    const holder = properties === undefined ? undefined : (first(properties, "SigningCertificateV2") ?? first(properties, "SigningCertificate"));
    const certDigest = holder === undefined ? undefined : first(holder, "CertDigest");
    if (certDigest === undefined) {
        return undefined;
    }
    const hash = hashNameOf(first(certDigest, "DigestMethod")?.getAttribute("Algorithm") ?? "");
    return hash === undefined ? false : sameBytes(await digest(hash, certificate), new Uint8Array(Buffer.from(text(first(certDigest, "DigestValue")), "base64")));
};

const signingTimeOf = (properties: Element | undefined): SigningTime | undefined => {
    const value = properties === undefined ? "" : (first(properties, "SigningTime")?.textContent?.trim() ?? "");
    const parsed = new Date(value);
    return value === "" || Number.isNaN(parsed.getTime()) ? undefined : { value: parsed.toISOString(), source: "xades-signing-time" };
};

// In-scope namespace declarations of an element, nearest first, so a copy canonicalises as the original would in place.
const inScopeNamespaces = (element: Element): Map<string, string> => {
    const namespaces = new Map<string, string>();
    for (let node: Element | null = element; node !== null; node = isElement(node.parentNode) ? node.parentNode : null) {
        for (const attribute of Array.from(node.attributes)) {
            const prefix = attribute.name === "xmlns" ? "" : attribute.name.startsWith("xmlns:") ? attribute.name.slice(6) : undefined;
            if (prefix !== undefined && !namespaces.has(prefix)) {
                namespaces.set(prefix, attribute.value);
            }
        }
    }
    return namespaces;
};

// The bytes a SignatureTimeStamp stamps: the ds:SignatureValue element, canonicalised by the time-stamp's own
// CanonicalizationMethod (inclusive C14N 1.0 when it names none), as EN 319 132-1 §5.3 says.
const signatureValueBytes = (signature: Element, method: string): Uint8Array | undefined => {
    const value = first(signature, "SignatureValue");
    if (value === undefined) {
        return undefined;
    }
    // SAFETY: cloneNode(true) of an Element is an Element.
    const copy = value.cloneNode(true) as Element;
    for (const [prefix, uri] of inScopeNamespaces(value)) {
        if (!copy.hasAttribute(prefix === "" ? "xmlns" : `xmlns:${prefix}`)) {
            copy.setAttribute(prefix === "" ? "xmlns" : `xmlns:${prefix}`, uri);
        }
    }
    const canonical = new XmlCanonicalizer(method.endsWith("#WithComments"), method.startsWith(C14N_EXCLUSIVE)).Canonicalize(copy);
    return new Uint8Array(Buffer.from(canonical, "utf8"));
};

// Every token of every SignatureTimeStamp (one element may carry several EncapsulatedTimeStamp).
const timestampsOf = (signature: Element, trust: TrustEvaluator): Promise<TimestampFacts[]> =>
    Promise.all(
        elements(signature, "SignatureTimeStamp").flatMap((stamp) => {
            const declared = first(stamp, "CanonicalizationMethod")?.getAttribute("Algorithm") ?? "";
            const stamped = signatureValueBytes(signature, declared === "" ? C14N_DEFAULT : declared);
            return elements(stamp, "EncapsulatedTimeStamp").map((token) => verifyTimestamp(new Uint8Array(Buffer.from(text(token), "base64")), stamped, "signature-timestamp", trust));
        }),
    );

interface Checked {
    readonly integrity: Integrity;
    readonly detail: string;
}

const checkSignature = async (document: Document, signature: Element, certificate: Uint8Array, input: XmlInput, references: readonly ReferenceFacts[]): Promise<Checked> => {
    const outside = references.filter(external);
    if (outside.length > 1) {
        return { integrity: "not-checked", detail: `the signature covers ${outside.length} external files; only one detached file can be supplied` };
    }
    if (outside.length === 1 && input.detached === undefined) {
        return { integrity: "not-checked", detail: `detached signature over "${outside[0]?.uri ?? ""}": pass that file as well (e-urzad verify SIGNATURE --content FILE)` };
    }
    // xmldsigjs's core SignedXml, not xadesjs's: the XAdES properties are read off the DOM here, and xadesjs's own model
    // of them refuses much of what is in use (archive time-stamps, revocation references, policy qualifiers) before a
    // single digest is checked.
    const signed = new SignedXml(document);
    try {
        signed.LoadXml(signature);
    } catch (cause) {
        const reason = causeText(cause);
        return /Unknown transform|not supported|Unsupported/i.test(reason)
            ? { integrity: "not-checked", detail: `the signature uses something this verifier does not implement: ${reason}` }
            : { integrity: "invalid", detail: `the signature's structure is broken: ${reason}` };
    }
    const detached = input.detached;
    if (detached !== undefined) {
        signed.contentHandler = (reference) => Promise.resolve(external({ uri: reference.Uri ?? "", type: "" }) ? toArrayBuffer(detached) : null);
    }
    try {
        // The key comes from the certificate the report names, in the algorithm the SignatureMethod declares: a KeyValue
        // element beside it is never consulted.
        const algorithm = { ...CryptoConfig.CreateSignatureAlgorithm(signed.XmlSignature.SignedInfo.SignatureMethod).algorithm };
        const key = await new X509Certificate(toArrayBuffer(certificate)).exportKey(algorithm);
        return (await signed.Verify({ key }))
            ? { integrity: "valid", detail: "every reference digest and the signature value match the signer certificate's key" }
            : { integrity: "invalid", detail: "the signature value does not match: the signed content or the signature changed" };
    } catch (cause) {
        const reason = causeText(cause);
        return /Unknown transform|not supported|Unsupported|Cannot get object by reference/i.test(reason)
            ? { integrity: "not-checked", detail: `the signature could not be checked here: ${reason}` }
            : { integrity: "invalid", detail: `the signature does not verify: ${reason}` };
    }
};

const unsignable = (index: number, scope: string, detail: string): SignatureFacts => ({
    index,
    format: "XMLDSig",
    integrity: "not-checked",
    integrityDetail: detail,
    scope,
    timestamps: [],
    trust: trustSkipped("the signature itself was not verified"),
    qualification: "not established: the signature was not checked",
    notes: [],
});

const verifyOne = async (document: Document, signature: Element, index: number, input: XmlInput): Promise<SignatureFacts> => {
    const references = referencesOf(signature);
    const scope = `references: ${references.map((reference) => describeReference(reference, document)).join("; ") || "none"}`;
    const der = signerCertificateOf(signature);
    if (der === undefined) {
        return unsignable(index, scope, "no X509Certificate in KeyInfo: a bare key does not say who signed, so nothing is reported as verified");
    }
    const properties = signedPropertiesOf(signature, references);
    const certificate = parseCertificate(der);
    const checked = await checkSignature(document, signature, der, input, references);
    const signer = await certificateFacts(certificate);
    const timestamps = await timestampsOf(signature, input.trust);
    const signingTime = signingTimeOf(properties);
    const at = timestamps.find((stamp) => stamp.integrity === "valid")?.time ?? signingTime?.value;
    const trust = await input.trust.evaluate(certificate, [], at === undefined ? undefined : new Date(at), "signer");
    const notes = properties === undefined && first(signature, "SignedProperties") !== undefined ? ["the XAdES properties are present but no reference signs them: their signing time and certificate binding are unsigned claims"] : [];
    return {
        index,
        format: properties === undefined ? "XMLDSig" : "XAdES",
        integrity: checked.integrity,
        integrityDetail: checked.detail,
        scope: input.detachedName === undefined ? scope : `${scope}; detached file checked: ${input.detachedName}`,
        signer,
        signerBound: await boundTo(properties, derOf(certificate)),
        signingTime,
        timestamps,
        trust,
        qualification: qualificationOf(checked.integrity, signer, trust),
        notes,
    };
};

export const verifyXml = async (input: XmlInput): Promise<SignatureFacts[]> => {
    const document = parseXml(input.bytes);
    const signatures = Array.from(document.getElementsByTagNameNS(DS, "Signature"));
    const results: SignatureFacts[] = [];
    for (const [index, signature] of signatures.entries()) {
        try {
            results.push(await verifyOne(document, signature, index, input));
        } catch (error) {
            results.push(unsignable(index, "unknown", `unreadable signature: ${causeText(error)}`));
        }
    }
    return results;
};
