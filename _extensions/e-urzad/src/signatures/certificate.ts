import * as asn1js from "asn1js";
import { Certificate, CertificatePolicies, type RelativeDistinguishedNames } from "pkijs";
import { digest, hex, toArrayBuffer } from "./engine.js";
import type { CertificateFacts, QcClaims, SubjectFields } from "./report.js";

// What a certificate says about its holder and about itself, read with PKI.js and asn1js. Nothing here judges trust:
// QcStatements are the issuer's CLAIMS, reported as claims (report.ts says why).

const NAMES: ReadonlyMap<string, string> = new Map([
    ["2.5.4.3", "CN"],
    ["2.5.4.4", "SN"],
    ["2.5.4.5", "SERIALNUMBER"],
    ["2.5.4.6", "C"],
    ["2.5.4.7", "L"],
    ["2.5.4.8", "ST"],
    ["2.5.4.9", "STREET"],
    ["2.5.4.10", "O"],
    ["2.5.4.11", "OU"],
    ["2.5.4.12", "T"],
    ["2.5.4.42", "G"],
    ["2.5.4.97", "organizationIdentifier"],
    ["1.2.840.113549.1.9.1", "E"],
]);

const SUBJECT_FIELDS: ReadonlyMap<string, keyof SubjectFields> = new Map([
    ["2.5.4.3", "commonName"],
    ["2.5.4.42", "givenName"],
    ["2.5.4.4", "surname"],
    ["2.5.4.5", "serialNumber"],
    ["2.5.4.10", "organization"],
    ["2.5.4.97", "organizationIdentifier"],
    ["2.5.4.6", "country"],
    ["1.2.840.113549.1.9.1", "email"],
]);

const QC_COMPLIANCE = "0.4.0.1862.1.1";
const QC_SSCD = "0.4.0.1862.1.4";
const QC_TYPE = "0.4.0.1862.1.6";
const QC_LEGISLATION = "0.4.0.1862.1.7";
const QC_TYPES: ReadonlyMap<string, string> = new Map([
    ["0.4.0.1862.1.6.1", "esign"],
    ["0.4.0.1862.1.6.2", "eseal"],
    ["0.4.0.1862.1.6.3", "web"],
]);

// ETSI EN 319 411-2 policies, and the older TS 101 456 ones Polish certificates issued before eIDAS still carry.
const POLICIES: ReadonlyMap<string, string> = new Map([
    ["0.4.0.194112.1.0", "QCP-n"],
    ["0.4.0.194112.1.1", "QCP-l"],
    ["0.4.0.194112.1.2", "QCP-n-qscd"],
    ["0.4.0.194112.1.3", "QCP-l-qscd"],
    ["0.4.0.194112.1.4", "QCP-w"],
    ["0.4.0.1456.1.1", "QCP+ (TS 101 456)"],
    ["0.4.0.1456.1.2", "QCP (TS 101 456)"],
]);

const textOf = (value: asn1js.AsnType): string => {
    if (value instanceof asn1js.BaseStringBlock) {
        return value.getValue();
    }
    return "";
};

const pairsOf = (name: RelativeDistinguishedNames): { readonly type: string; readonly value: string }[] =>
    name.typesAndValues.map((pair) => ({ type: pair.type, value: textOf(pair.value) }));

// RFC 4514 order (the most specific attribute first), with the short names readers know.
export const formatName = (name: RelativeDistinguishedNames): string =>
    pairsOf(name)
        .toReversed()
        .map((pair) => `${NAMES.get(pair.type) ?? pair.type}=${pair.value}`)
        .join(", ");

const subjectFieldsOf = (name: RelativeDistinguishedNames): SubjectFields => {
    const fields: Partial<Record<keyof SubjectFields, string>> = {};
    for (const pair of pairsOf(name)) {
        const key = SUBJECT_FIELDS.get(pair.type);
        if (key !== undefined && fields[key] === undefined) {
            fields[key] = pair.value;
        }
    }
    return fields;
};

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

// The 11-digit national number when the serialNumber attribute carries one in either form Polish qualified certificates
// use (ETSI EN 319 412-1 "PNOPL-", or the older "PESEL:"), and only when its check digit holds.
export const peselOf = (serialNumber: string | undefined): string | undefined => {
    const digits = /^(?:PNOPL-|PESEL:\s*)(\d{11})$/i.exec(serialNumber?.trim() ?? "")?.[1];
    if (digits === undefined) {
        return undefined;
    }
    const sum = PESEL_WEIGHTS.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
    return (10 - (sum % 10)) % 10 === Number(digits[10]) ? digits : undefined;
};

const oidsIn = (block: asn1js.AsnType | undefined): string[] =>
    block instanceof asn1js.Sequence ? block.valueBlock.value.flatMap((item) => (item instanceof asn1js.ObjectIdentifier ? [item.valueBlock.toString()] : [])) : [];

const legislationIn = (block: asn1js.AsnType | undefined): string[] =>
    block instanceof asn1js.Sequence ? block.valueBlock.value.flatMap((item) => (item instanceof asn1js.PrintableString ? [item.getValue()] : [])) : [];

const NO_QC: QcClaims = { compliance: false, qscd: false, types: [], legislation: [], statements: [] };

// QCStatements ::= SEQUENCE OF QCStatement { statementId OID, statementInfo ANY OPTIONAL } (RFC 3739, ETSI EN 319 412-5).
const qcClaimsOf = (certificate: Certificate): QcClaims => {
    const extension = certificate.extensions?.find((entry) => entry.extnID === "1.3.6.1.5.5.7.1.3");
    if (extension === undefined) {
        return NO_QC;
    }
    const decoded = asn1js.fromBER(extension.extnValue.valueBlock.valueHexView);
    if (decoded.offset === -1 || !(decoded.result instanceof asn1js.Sequence)) {
        return NO_QC;
    }
    const statements: string[] = [];
    const types: string[] = [];
    const legislation: string[] = [];
    for (const statement of decoded.result.valueBlock.value) {
        if (!(statement instanceof asn1js.Sequence)) {
            continue;
        }
        const [id, info] = statement.valueBlock.value;
        if (!(id instanceof asn1js.ObjectIdentifier)) {
            continue;
        }
        const oid = id.valueBlock.toString();
        statements.push(oid);
        if (oid === QC_TYPE) {
            types.push(...oidsIn(info).map((type) => QC_TYPES.get(type) ?? type));
        }
        if (oid === QC_LEGISLATION) {
            legislation.push(...legislationIn(info));
        }
    }
    return { compliance: statements.includes(QC_COMPLIANCE), qscd: statements.includes(QC_SSCD), types, legislation, statements };
};

const policiesOf = (certificate: Certificate): string[] => {
    const parsed = certificate.extensions?.find((entry) => entry.extnID === "2.5.29.32")?.parsedValue;
    if (!(parsed instanceof CertificatePolicies)) {
        return [];
    }
    return parsed.certificatePolicies.map((policy) => {
        const name = POLICIES.get(policy.policyIdentifier);
        return name === undefined ? policy.policyIdentifier : `${name} (${policy.policyIdentifier})`;
    });
};

export const derOf = (certificate: Certificate): Uint8Array => new Uint8Array(certificate.toSchema(true).toBER(false));

export const certificateFacts = async (certificate: Certificate): Promise<CertificateFacts> => {
    const subjectFields = subjectFieldsOf(certificate.subject);
    return {
        subject: formatName(certificate.subject),
        subjectFields,
        pesel: peselOf(subjectFields.serialNumber),
        issuer: formatName(certificate.issuer),
        serialNumber: hex(certificate.serialNumber.valueBlock.valueHexView),
        validFrom: certificate.notBefore.value.toISOString(),
        validTo: certificate.notAfter.value.toISOString(),
        sha256: hex(await digest("SHA-256", derOf(certificate))),
        qc: qcClaimsOf(certificate),
        policies: policiesOf(certificate),
    };
};

export const parseCertificate = (der: Uint8Array): Certificate => Certificate.fromBER(toArrayBuffer(der));

export const validAt = (certificate: Certificate, at: Date): boolean =>
    certificate.notBefore.value.getTime() <= at.getTime() && at.getTime() <= certificate.notAfter.value.getTime();
