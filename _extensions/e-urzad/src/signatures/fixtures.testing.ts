import * as asn1js from "asn1js";
import {
    AlgorithmIdentifier,
    Attribute,
    AttributeTypeAndValue,
    BasicConstraints,
    Certificate,
    CertificatePolicies,
    ContentInfo,
    EncapsulatedContentInfo,
    Extension,
    ExtKeyUsage,
    IssuerAndSerialNumber,
    MessageImprint,
    PolicyInformation,
    SignedAndUnsignedAttributes,
    SignedData,
    SignerInfo,
    TSTInfo,
} from "pkijs";
import { Parse, SignedXml } from "xadesjs";
import { Stringify, XmlDsigExcC14NTransform } from "xmldsigjs";
import { derOf } from "./certificate.js";
import { digest, ensureCryptoEngines, subtle, toArrayBuffer } from "./engine.js";

// Synthetic PKI for the suites: keys generated per run, certificates and signatures built with the same libraries the
// verifier reads them with. No real person, office or certificate appears; the national number is the check-digit-valid
// example the Polish government documents itself use.

export const EXAMPLE_PESEL = "02070803628";

const RSA: RsaHashedKeyGenParams = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export interface Party {
    readonly certificate: Certificate;
    readonly keys: CryptoKeyPair;
    readonly der: Uint8Array;
    readonly base64: string;
}

export interface PartyOptions {
    readonly subject: readonly (readonly [string, string])[];
    readonly issuer?: Party;
    readonly serial: number;
    readonly ca?: boolean;
    readonly qc?: { readonly compliance: boolean; readonly qscd: boolean; readonly type?: string };
    readonly policies?: readonly string[];
    readonly timestamping?: boolean;
    readonly notBefore?: Date;
    readonly notAfter?: Date;
}

const DAY = 86_400_000;

const keyUsage = (ca: boolean): Extension =>
    new Extension({
        extnID: "2.5.29.15",
        critical: true,
        // keyCertSign + cRLSign for a CA, digitalSignature + nonRepudiation for a signer.
        extnValue: new asn1js.BitString({ valueHex: new Uint8Array([ca ? 0x06 : 0xc0]).buffer, unusedBits: 1 }).toBER(false),
    });

const qcStatements = (qc: NonNullable<PartyOptions["qc"]>): Extension => {
    const statement = (oid: string, info?: asn1js.AsnType): asn1js.Sequence => new asn1js.Sequence({ value: info === undefined ? [new asn1js.ObjectIdentifier({ value: oid })] : [new asn1js.ObjectIdentifier({ value: oid }), info] });
    const statements = [
        ...(qc.compliance ? [statement("0.4.0.1862.1.1")] : []),
        ...(qc.qscd ? [statement("0.4.0.1862.1.4")] : []),
        ...(qc.type === undefined ? [] : [statement("0.4.0.1862.1.6", new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: qc.type })] }))]),
    ];
    return new Extension({ extnID: "1.3.6.1.5.5.7.1.3", critical: false, extnValue: new asn1js.Sequence({ value: statements }).toBER(false) });
};

const extensionsFor = (options: PartyOptions): Extension[] => [
    new Extension({ extnID: "2.5.29.19", critical: true, extnValue: new BasicConstraints({ cA: options.ca === true }).toSchema().toBER(false) }),
    keyUsage(options.ca === true),
    ...(options.qc === undefined ? [] : [qcStatements(options.qc)]),
    ...(options.policies === undefined
        ? []
        : [new Extension({ extnID: "2.5.29.32", critical: false, extnValue: new CertificatePolicies({ certificatePolicies: options.policies.map((policyIdentifier) => new PolicyInformation({ policyIdentifier })) }).toSchema().toBER(false) })]),
    ...(options.timestamping === true ? [new Extension({ extnID: "2.5.29.37", critical: true, extnValue: new ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.8"] }).toSchema().toBER(false) })] : []),
];

export const party = async (options: PartyOptions): Promise<Party> => {
    ensureCryptoEngines();
    const keys = await subtle().generateKey(RSA, true, ["sign", "verify"]);
    const certificate = new Certificate();
    certificate.version = 2;
    certificate.serialNumber = new asn1js.Integer({ value: options.serial });
    for (const [type, value] of options.subject) {
        certificate.subject.typesAndValues.push(new AttributeTypeAndValue({ type, value: type === "2.5.4.6" || type === "2.5.4.5" ? new asn1js.PrintableString({ value }) : new asn1js.Utf8String({ value }) }));
    }
    certificate.issuer = options.issuer?.certificate.subject ?? certificate.subject;
    certificate.notBefore.value = options.notBefore ?? new Date(Date.now() - DAY);
    certificate.notAfter.value = options.notAfter ?? new Date(Date.now() + 365 * DAY);
    certificate.extensions = extensionsFor(options);
    await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
    await certificate.sign(options.issuer?.keys.privateKey ?? keys.privateKey, "SHA-256");
    const der = derOf(certificate);
    return { certificate, keys, der, base64: Buffer.from(der).toString("base64") };
};

export interface Pki {
    readonly root: Party;
    readonly signer: Party;
    readonly tsa: Party;
    readonly stranger: Party;
}

// A qualified-looking CA with a natural-person signer and a TSA under it, plus an unrelated self-signed signer.
export const pki = async (): Promise<Pki> => {
    const root = await party({ subject: [["2.5.4.6", "PL"], ["2.5.4.10", "Example Trust Services"], ["2.5.4.3", "Example Qualified CA"]], serial: 1, ca: true });
    const signer = await party({
        subject: [["2.5.4.6", "PL"], ["2.5.4.42", "Anna"], ["2.5.4.4", "Przykładowa"], ["2.5.4.5", `PNOPL-${EXAMPLE_PESEL}`], ["2.5.4.3", "Anna Przykładowa"]],
        issuer: root,
        serial: 1001,
        qc: { compliance: true, qscd: true, type: "0.4.0.1862.1.6.1" },
        policies: ["0.4.0.194112.1.2"],
    });
    const tsa = await party({ subject: [["2.5.4.6", "PL"], ["2.5.4.10", "Example Trust Services"], ["2.5.4.3", "Example TSA"]], issuer: root, serial: 1002, timestamping: true });
    const stranger = await party({ subject: [["2.5.4.6", "PL"], ["2.5.4.3", "Anna Przykładowa"]], serial: 1001 });
    return { root, signer, tsa, stranger };
};

const attribute = (type: string, value: asn1js.AsnType): Attribute => new Attribute({ type, values: [value] });

const essV2 = async (certificate: Party): Promise<Attribute> =>
    attribute(
        "1.2.840.113549.1.9.16.2.47",
        new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: toArrayBuffer(await digest("SHA-256", certificate.der)) })] })] })] }),
    );

const contentInfo = (signed: SignedData): Uint8Array => new Uint8Array(new ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: signed.toSchema(true) }).toSchema().toBER(false));

// An RFC 3161 token over `imprinted`, signed by `tsa`.
export const timestampToken = async (imprinted: Uint8Array, tsa: Party, time = new Date()): Promise<Uint8Array> => {
    const info = new TSTInfo({
        version: 1,
        policy: "1.2.3.4.1",
        messageImprint: new MessageImprint({
            hashAlgorithm: new AlgorithmIdentifier({ algorithmId: "2.16.840.1.101.3.4.2.1" }),
            hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(await digest("SHA-256", imprinted)) }),
        }),
        serialNumber: new asn1js.Integer({ value: 7 }),
        genTime: time,
    });
    const content = info.toSchema().toBER(false);
    const signed = new SignedData({
        version: 3,
        encapContentInfo: new EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.9.16.1.4", eContent: new asn1js.OctetString({ valueHex: content }) }),
        certificates: [tsa.certificate],
        signerInfos: [
            new SignerInfo({
                version: 1,
                sid: new IssuerAndSerialNumber({ issuer: tsa.certificate.issuer, serialNumber: tsa.certificate.serialNumber }),
                signedAttrs: new SignedAndUnsignedAttributes({
                    type: 0,
                    attributes: [
                        attribute("1.2.840.113549.1.9.3", new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.9.16.1.4" })),
                        attribute("1.2.840.113549.1.9.4", new asn1js.OctetString({ valueHex: toArrayBuffer(await digest("SHA-256", new Uint8Array(content))) })),
                    ],
                }),
            }),
        ],
    });
    // PKI.js's constructor re-wraps eContent as a constructed OCTET STRING; a TSA sends a primitive one, and that is
    // what PKI.js's own token check reads.
    signed.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: content });
    await signed.sign(tsa.keys.privateKey, 0, "SHA-256");
    return contentInfo(signed);
};

export interface CmsOptions {
    readonly detached?: boolean;
    readonly ess?: boolean;
    readonly signingTime?: Date;
    readonly timestampBy?: Party;
    // Certificates to carry instead of the signer's own (a swapped bag).
    readonly carry?: readonly Party[];
}

export const signCms = async (content: Uint8Array, signer: Party, options: CmsOptions = {}): Promise<Uint8Array> => {
    const attributes = [
        attribute("1.2.840.113549.1.9.3", new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.1" })),
        attribute("1.2.840.113549.1.9.4", new asn1js.OctetString({ valueHex: toArrayBuffer(await digest("SHA-256", content)) })),
        ...(options.signingTime === undefined ? [] : [attribute("1.2.840.113549.1.9.5", new asn1js.UTCTime({ valueDate: options.signingTime }))]),
        ...(options.ess === false ? [] : [await essV2(signer)]),
    ];
    const encapsulated = new EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.7.1" });
    if (options.detached !== true) {
        encapsulated.eContent = new asn1js.OctetString({ valueHex: toArrayBuffer(content) });
    }
    const signed = new SignedData({
        version: 1,
        encapContentInfo: encapsulated,
        certificates: (options.carry ?? [signer]).map((entry) => entry.certificate),
        signerInfos: [
            new SignerInfo({
                version: 1,
                sid: new IssuerAndSerialNumber({ issuer: signer.certificate.issuer, serialNumber: signer.certificate.serialNumber }),
                signedAttrs: new SignedAndUnsignedAttributes({ type: 0, attributes }),
            }),
        ],
    });
    await signed.sign(signer.keys.privateKey, 0, "SHA-256", options.detached === true ? toArrayBuffer(content) : undefined);
    const signerInfo = signed.signerInfos[0];
    if (options.timestampBy !== undefined && signerInfo !== undefined) {
        const token = await timestampToken(signerInfo.signature.valueBlock.valueHexView, options.timestampBy);
        signerInfo.unsignedAttrs = new SignedAndUnsignedAttributes({ type: 1, attributes: [attribute("1.2.840.113549.1.9.16.2.14", asn1js.fromBER(toArrayBuffer(token)).result)] });
    }
    return contentInfo(signed);
};

const serialize = (document: Document): string => Stringify(document);

export interface XadesOptions {
    readonly timestampBy?: Party;
}

// An enveloped XAdES-BES (optionally -T) signature over a small XML document.
export const signXadesEnveloped = async (xml: string, signer: Party, options: XadesOptions = {}): Promise<string> => {
    ensureCryptoEngines();
    const document = Parse(xml);
    const signed = new SignedXml();
    const signature = await signed.Sign({ name: "RSASSA-PKCS1-v1_5" }, signer.keys.privateKey, document, {
        x509: [signer.base64],
        references: [{ hash: "SHA-256", transforms: ["enveloped", "exc-c14n"] }],
        signingCertificate: signer.base64,
        signingTime: { value: new Date() },
    });
    const element = signature.GetXml();
    if (element === null) {
        throw new Error("xadesjs produced no signature element");
    }
    document.documentElement.appendChild(element);
    if (options.timestampBy !== undefined) {
        await addXadesTimestamp(document, options.timestampBy);
    }
    return serialize(document);
};

// A detached XAdES signature over a separate file, referenced by its name.
export const signXadesDetached = async (content: Uint8Array, name: string, signer: Party): Promise<string> => {
    ensureCryptoEngines();
    const signed = new SignedXml();
    await signed.Sign({ name: "RSASSA-PKCS1-v1_5" }, signer.keys.privateKey, toArrayBuffer(content), {
        x509: [signer.base64],
        references: [{ uri: name, hash: "SHA-256" }],
        signingCertificate: signer.base64,
        signingTime: { value: new Date() },
    });
    return signed.toString();
};

const XADES = "http://uri.etsi.org/01903/v1.3.2#";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";

// XAdES-T: a SignatureTimeStamp over the exclusive-canonical ds:SignatureValue, computed here with xmldsigjs's own
// transform (not the verifier's code path).
const addXadesTimestamp = async (document: Document, tsa: Party): Promise<void> => {
    const value = document.getElementsByTagNameNS(DS, "SignatureValue")[0];
    const qualifying = document.getElementsByTagNameNS(XADES, "QualifyingProperties")[0];
    if (value === undefined || qualifying === undefined) {
        throw new Error("no SignatureValue or QualifyingProperties to stamp");
    }
    const transform = new XmlDsigExcC14NTransform();
    transform.LoadInnerXml(value);
    const token = await timestampToken(new Uint8Array(Buffer.from(transform.GetOutput(), "utf8")), tsa);
    const prefix = qualifying.prefix === null ? "" : `${qualifying.prefix}:`;
    const make = (name: string, namespace = XADES): Element => document.createElementNS(namespace, namespace === XADES ? `${prefix}${name}` : `ds:${name}`);
    const unsigned = make("UnsignedProperties");
    const properties = make("UnsignedSignatureProperties");
    const stamp = make("SignatureTimeStamp");
    const method = make("CanonicalizationMethod", DS);
    method.setAttribute("Algorithm", EXC_C14N);
    const encapsulated = make("EncapsulatedTimeStamp");
    encapsulated.textContent = Buffer.from(token).toString("base64");
    stamp.appendChild(method);
    stamp.appendChild(encapsulated);
    properties.appendChild(stamp);
    unsigned.appendChild(properties);
    qualifying.appendChild(unsigned);
};

const pdfObjects = (placeholder: string, byteRange: string): string[] => [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /V 5 0 R /P 3 0 R /T (Signature1) >>",
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange ${byteRange} /Contents <${placeholder}> /M (D:20261013120000Z) >>`,
];

const pdfText = (placeholder: string, byteRange: string): string => {
    let text = "%PDF-1.7\n";
    const offsets: number[] = [];
    for (const [index, body] of pdfObjects(placeholder, byteRange).entries()) {
        offsets.push(text.length);
        text += `${index + 1} 0 obj\n${body}\nendobj\n`;
    }
    const xref = text.length;
    text += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    return `${text}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
};

// A one-page PDF with a PAdES (ETSI.CAdES.detached) signature over the whole file.
export const signedPdf = async (signer: Party, options: CmsOptions = {}): Promise<Uint8Array> => {
    const size = 16_384;
    const draft = pdfText("0".repeat(size), `[${"0".repeat(10)} ${"0".repeat(10)} ${"0".repeat(10)} ${"0".repeat(10)}]`);
    const start = draft.indexOf("/Contents <") + "/Contents ".length;
    const end = start + size + 2;
    const ranges = [0, start, end, draft.length - end].map((value) => String(value).padStart(10, "0"));
    const text = pdfText("0".repeat(size), `[${ranges.join(" ")}]`);
    const bytes = Buffer.from(text, "latin1");
    const signed = Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
    const signature = Buffer.from(await signCms(new Uint8Array(signed), signer, { ...options, detached: true })).toString("hex");
    bytes.write(signature.padEnd(size, "0"), start + 1, "latin1");
    return new Uint8Array(bytes);
};

const TSL_NS = "http://uri.etsi.org/02231/v2#";
const MIME_NS = "http://uri.etsi.org/02231/v2/additionaltypes#";

export interface ListService {
    readonly type: string;
    readonly name: string;
    readonly certificate: Party;
    readonly status?: string;
}

export interface ListPointerFixture {
    readonly territory: string;
    readonly location: string;
    readonly signer: Party;
}

const pointerXml = (pointer: ListPointerFixture): string =>
    `<OtherTSLPointer><ServiceDigitalIdentities><ServiceDigitalIdentity><DigitalId><X509Certificate>${pointer.signer.base64}</X509Certificate></DigitalId></ServiceDigitalIdentity></ServiceDigitalIdentities><TSLLocation>${pointer.location}</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>${pointer.territory}</SchemeTerritory></OtherInformation><OtherInformation><tslx:MimeType xmlns:tslx="${MIME_NS}">application/vnd.etsi.tsl+xml</tslx:MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>`;

const serviceXml = (service: ListService): string =>
    `<TSPService><ServiceInformation><ServiceTypeIdentifier>${service.type}</ServiceTypeIdentifier><ServiceName><Name xml:lang="en">${service.name}</Name></ServiceName><ServiceDigitalIdentity><DigitalId><X509Certificate>${service.certificate.base64}</X509Certificate></DigitalId></ServiceDigitalIdentity><ServiceStatus>${service.status ?? "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted"}</ServiceStatus><StatusStartingTime>2016-07-01T00:00:00Z</StatusStartingTime></ServiceInformation></TSPService>`;

// A trusted list (or, with pointers, a list of lists) signed by `signer` over the whole document.
export const trustedListXml = async (territory: string, services: readonly ListService[], pointers: readonly ListPointerFixture[], signer: Party): Promise<string> => {
    ensureCryptoEngines();
    const xml = `<TrustServiceStatusList xmlns="${TSL_NS}" Id="tsl"><SchemeInformation><TSLVersionIdentifier>5</TSLVersionIdentifier><TSLSequenceNumber>42</TSLSequenceNumber><SchemeTerritory>${territory}</SchemeTerritory><ListIssueDateTime>2026-09-01T00:00:00Z</ListIssueDateTime><NextUpdate><dateTime>2027-03-01T00:00:00Z</dateTime></NextUpdate><PointersToOtherTSL>${pointers.map(pointerXml).join("")}</PointersToOtherTSL></SchemeInformation><TrustServiceProviderList><TrustServiceProvider><TSPInformation><TSPName><Name xml:lang="en">Example Trust Services</Name></TSPName></TSPInformation><TSPServices>${services.map(serviceXml).join("")}</TSPServices></TrustServiceProvider></TrustServiceProviderList></TrustServiceStatusList>`;
    const document = Parse(xml);
    const signed = new SignedXml();
    const signature = await signed.Sign({ name: "RSASSA-PKCS1-v1_5" }, signer.keys.privateKey, document, {
        x509: [signer.base64],
        references: [{ uri: "", hash: "SHA-256", transforms: ["enveloped", "exc-c14n"] }],
    });
    const element = signature.GetXml();
    if (element === null) {
        throw new Error("xadesjs produced no signature element");
    }
    document.documentElement.appendChild(element);
    return serialize(document);
};
