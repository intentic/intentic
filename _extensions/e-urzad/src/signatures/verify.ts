import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { verifyCms } from "./cms.js";
import { ensureCryptoEngines } from "./engine.js";
import { verifyPdf } from "./pdf.js";
import { type SignatureFacts, type SignatureFormat, summaryOf, type VerificationReport } from "./report.js";
import type { TrustEvaluator } from "./timestamp.js";
import { verifyXml } from "./xml.js";

// One entry for every format: decide what the file is (by its bytes first, its name second), run that verifier, and
// wrap the answer in a report that always says what was and was not checked.

export interface NamedBytes {
    readonly name: string;
    readonly bytes: Uint8Array;
}

const PEM = /-----BEGIN (?:PKCS7|CMS|SIGNED DATA)-----([\s\S]+?)-----END (?:PKCS7|CMS|SIGNED DATA)-----/;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

// A CMS signature as DER, whether it arrived as DER, PEM or bare Base64 (all three occur as .sig files).
const cmsDer = (bytes: Uint8Array): Uint8Array | undefined => {
    if (bytes[0] === 0x30) {
        return bytes;
    }
    const text = Buffer.from(bytes).toString("latin1");
    const armoured = PEM.exec(text)?.[1] ?? (BASE64.test(text) ? text : undefined);
    const decoded = armoured === undefined ? undefined : new Uint8Array(Buffer.from(armoured.replaceAll(/\s/g, ""), "base64"));
    return decoded?.[0] === 0x30 ? decoded : undefined;
};

const detectFormat = (name: string, bytes: Uint8Array): SignatureFormat => {
    const head = Buffer.from(bytes.subarray(0, 64)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("%PDF-")) {
        return "PAdES";
    }
    if (head.startsWith("<")) {
        return "XAdES";
    }
    const extension = extname(name).toLowerCase();
    if ([".p7s", ".p7m", ".sig", ".p7", ".cms", ".asn1"].includes(extension) || cmsDer(bytes) !== undefined) {
        return "CAdES";
    }
    return "unknown";
};

const report = (file: string, detected: SignatureFormat, signatures: readonly SignatureFacts[], problem?: string): VerificationReport => ({
    file,
    detected,
    signatures,
    problem,
    summary: problem ?? summaryOf(signatures),
});

export const verifyBytes = async (file: NamedBytes, content: NamedBytes | undefined, trust: TrustEvaluator): Promise<VerificationReport> => {
    ensureCryptoEngines();
    const detected = detectFormat(file.name, file.bytes);
    try {
        if (detected === "PAdES") {
            const signatures = await verifyPdf(file.bytes, trust);
            return report(file.name, detected, signatures, signatures.length === 0 ? "no signature dictionary (/ByteRange) in this PDF" : undefined);
        }
        if (detected === "XAdES") {
            const signatures = await verifyXml({ bytes: file.bytes, detached: content?.bytes, detachedName: content?.name, trust });
            return report(file.name, detected, signatures, signatures.length === 0 ? "no ds:Signature element in this XML" : undefined);
        }
        const der = detected === "CAdES" ? cmsDer(file.bytes) : undefined;
        if (der === undefined) {
            return report(file.name, detected, [], "not a supported signature format: expected XAdES (.xml, .xades), PAdES (signed .pdf) or CAdES (.p7s, .p7m, .sig)");
        }
        const scope = content === undefined ? "detached content (not supplied)" : `the detached file ${content.name} (${content.bytes.byteLength} bytes)`;
        return report(file.name, detected, await verifyCms({ bytes: der, detached: content?.bytes, format: "CAdES", scope, trust }));
    } catch (error) {
        return report(file.name, detected, [], `could not read the signature: ${error instanceof Error ? error.message : "malformed file"}`);
    }
};

export const verifyFile = async (path: string, contentPath: string | undefined, trust: TrustEvaluator): Promise<VerificationReport> =>
    verifyBytes(
        { name: basename(path), bytes: new Uint8Array(await readFile(path)) },
        contentPath === undefined ? undefined : { name: basename(contentPath), bytes: new Uint8Array(await readFile(contentPath)) },
        trust,
    );
