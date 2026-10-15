import { enclosedContent, verifyCms } from "./cms.js";
import { causeText, digest, sameBytes } from "./engine.js";
import { qualificationOf, type SignatureFacts, type SigningTime, trustSkipped } from "./report.js";
import { type TrustEvaluator, verifyTimestamp } from "./timestamp.js";

// PAdES and the older PDF signatures. A PDF signature dictionary names the bytes it covers in /ByteRange [a b c d]: the
// file from a for b bytes, then from c for d bytes, leaving out exactly the hex string /Contents that holds the CMS. So
// the signature dictionary is always written out plainly in the file (never inside a compressed object stream, or the
// gap could not be its hex string), which is why reading it off the raw bytes finds every one. What it covers is then
// checked by the CMS verifier like any detached signature.

const BYTE_RANGE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
const SCAN_LIMIT = 65_536;

interface Found {
    readonly ranges: readonly [number, number, number, number];
    readonly contents: Uint8Array;
    readonly dictionary: string;
}

// A signature dictionary whose byte ranges cannot be what was signed (past the end of the file, overlapping, not
// starting at 0, not leaving out exactly the /Contents string): reported as a broken signature, never as no signature.
interface Broken {
    readonly ranges: readonly number[];
    readonly problem: string;
}

const rangeProblem = (ranges: readonly number[], length: number): string | undefined => {
    const [start, first, second, rest] = ranges;
    if (ranges.length !== 4 || start === undefined || first === undefined || second === undefined || rest === undefined || !ranges.every((value) => Number.isSafeInteger(value))) {
        return "the /ByteRange is not four integers";
    }
    if (start !== 0 || first <= 0 || second <= first) {
        return "the /ByteRange does not start at the file's first byte, or its ranges overlap";
    }
    return second + rest > length ? `the /ByteRange reaches byte ${second + rest}, past the end of the file (${length} bytes): the file was cut or changed` : undefined;
};

// The `<< … >>` around a position, skipping the /Contents gap whose hex never holds a delimiter anyway.
const dictionaryAround = (text: string, at: number, gap: readonly [number, number]): string => {
    let start = at;
    for (let depth = 0, index = at; index > Math.max(0, at - SCAN_LIMIT); index -= 1) {
        if (index >= gap[0] && index < gap[1]) {
            continue;
        }
        if (text.startsWith(">>", index)) {
            depth += 1;
        } else if (text.startsWith("<<", index)) {
            if (depth === 0) {
                start = index;
                break;
            }
            depth -= 1;
        }
    }
    let end = at;
    for (let depth = 0, index = at; index < Math.min(text.length, at + SCAN_LIMIT); index += 1) {
        if (index >= gap[0] && index < gap[1]) {
            continue;
        }
        if (text.startsWith("<<", index)) {
            depth += 1;
        } else if (text.startsWith(">>", index)) {
            if (depth === 0) {
                end = index + 2;
                break;
            }
            depth -= 1;
        }
    }
    return text.slice(start, gap[0]) + text.slice(gap[1], end);
};

const found = (text: string, length: number): (Found | Broken)[] => {
    const seen = new Set<string>();
    const signatures: (Found | Broken)[] = [];
    for (const match of text.matchAll(BYTE_RANGE)) {
        const ranges = match.slice(1, 5).map(Number);
        const key = ranges.join(" ");
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const problem = rangeProblem(ranges, length);
        const [, first = 0, second = 0, rest = 0] = ranges;
        const hex = problem === undefined ? /^<([0-9A-Fa-f\s]*)>$/.exec(text.slice(first, second))?.[1] : undefined;
        if (problem !== undefined || hex === undefined) {
            signatures.push({ ranges, problem: problem ?? "the bytes the /ByteRange leaves out are not exactly the /Contents hex string" });
            continue;
        }
        signatures.push({ ranges: [0, first, second, rest], contents: new Uint8Array(Buffer.from(hex.replaceAll(/\s/g, ""), "hex")), dictionary: dictionaryAround(text, match.index, [first, second]) });
    }
    return signatures;
};

const nameIn = (dictionary: string, key: string): string | undefined => new RegExp(`/${key}\\s*/([A-Za-z0-9.#_-]+)`).exec(dictionary)?.[1];

// PDF dates: D:YYYYMMDDHHmmSSOHH'mm' with everything after the year optional.
export const pdfDate = (dictionary: string): SigningTime | undefined => {
    const match = /\/M\s*\(D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?\)/.exec(dictionary);
    if (match === null) {
        return undefined;
    }
    const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", sign = "Z", offsetHours = "00", offsetMinutes = "00"] = match;
    const zone = sign === "Z" || sign === "z" ? "Z" : `${sign}${offsetHours}:${offsetMinutes}`;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
    return Number.isNaN(parsed.getTime()) ? undefined : { value: parsed.toISOString(), source: "pdf-dictionary" };
};

const signedBytes = (bytes: Uint8Array, [, first, second, rest]: readonly [number, number, number, number]): Uint8Array => {
    const signed = new Uint8Array(first + rest);
    signed.set(bytes.subarray(0, first), 0);
    signed.set(bytes.subarray(second, second + rest), first);
    return signed;
};

const revisionNote = (ranges: readonly [number, number, number, number], length: number): string => {
    const end = ranges[2] + ranges[3];
    return end === length
        ? "covers the whole file as it is now"
        : `covers the file up to byte ${end}; ${length - end} bytes were appended later (incremental updates: annotations, form fields or further signatures, not covered by this signature)`;
};

const documentTimestamp = async (index: number, signature: Found, signed: Uint8Array, scope: string, trust: TrustEvaluator): Promise<SignatureFacts> => {
    const stamp = await verifyTimestamp(signature.contents, signed, "document-timestamp", trust);
    return {
        index,
        format: "PDF timestamp",
        integrity: stamp.integrity,
        integrityDetail: stamp.detail,
        scope,
        timestamps: [stamp],
        trust: stamp.trust,
        qualification: "not applicable: a document time-stamp proves when the document existed, not who signed it",
        notes: [],
    };
};

// adbe.pkcs7.sha1: the CMS encloses a SHA-1 digest of the signed ranges rather than signing them as detached content.
const sha1Signature = async (signature: Found, signed: Uint8Array, scope: string, notes: string[], trust: TrustEvaluator): Promise<SignatureFacts[]> => {
    const results = await verifyCms({ bytes: signature.contents, format: "PAdES", scope, trust, notes });
    const enclosed = enclosedContent(signature.contents);
    const matches = enclosed !== undefined && sameBytes(enclosed, await digest("SHA-1", signed));
    return results.map((result) =>
        matches || result.integrity !== "valid"
            ? result
            : { ...result, integrity: "invalid", integrityDetail: "the enclosed SHA-1 digest does not match the signed byte ranges", qualification: qualificationOf("invalid", result.signer, result.trust) },
    );
};

const unsupported = (index: number, scope: string, subFilter: string): SignatureFacts => ({
    index,
    format: "PAdES",
    integrity: "not-checked",
    integrityDetail: `unsupported PDF signature type ${subFilter}`,
    scope,
    timestamps: [],
    trust: trustSkipped("the signature itself was not verified"),
    qualification: "not established: the signature was not checked",
    notes: [],
});

const verifyOne = async (bytes: Uint8Array, signature: Found, index: number, trust: TrustEvaluator): Promise<SignatureFacts[]> => {
    const subFilter = nameIn(signature.dictionary, "SubFilter") ?? "adbe.pkcs7.detached";
    const signed = signedBytes(bytes, signature.ranges);
    const scope = `PDF byte ranges [${signature.ranges.join(" ")}]: ${revisionNote(signature.ranges, bytes.byteLength)}`;
    if (subFilter === "ETSI.RFC3161" || nameIn(signature.dictionary, "Type") === "DocTimeStamp") {
        return [await documentTimestamp(index, signature, signed, scope, trust)];
    }
    const notes = [`SubFilter ${subFilter}${subFilter === "ETSI.CAdES.detached" ? " (PAdES baseline)" : ""}; PDF permissions (DocMDP) and what later revisions changed are not assessed`];
    if (subFilter === "adbe.pkcs7.sha1") {
        return sha1Signature(signature, signed, scope, notes, trust);
    }
    if (subFilter !== "adbe.pkcs7.detached" && subFilter !== "ETSI.CAdES.detached") {
        return [unsupported(index, scope, subFilter)];
    }
    const results = await verifyCms({ bytes: signature.contents, detached: signed, format: "PAdES", scope, trust, notes });
    const claimed = pdfDate(signature.dictionary);
    return results.map((result) => ({ ...result, index, signingTime: result.signingTime ?? claimed }));
};

export const verifyPdf = async (bytes: Uint8Array, trust: TrustEvaluator): Promise<SignatureFacts[]> => {
    const text = Buffer.from(bytes).toString("latin1");
    if (!text.startsWith("%PDF-")) {
        throw new Error("not a PDF file (no %PDF- header)");
    }
    const signatures = found(text, bytes.byteLength);
    const results: SignatureFacts[] = [];
    for (const [index, signature] of signatures.entries()) {
        const scope = `PDF byte ranges [${signature.ranges.join(" ")}]`;
        if ("problem" in signature) {
            results.push({ ...unsupported(index, scope, "signature"), integrity: "invalid", integrityDetail: signature.problem });
            continue;
        }
        try {
            results.push(...(await verifyOne(bytes, signature, index, trust)));
        } catch (error) {
            results.push({ ...unsupported(index, scope, "signature"), integrityDetail: `unreadable signature: ${causeText(error)}` });
        }
    }
    return results;
};
