import { readFile } from "node:fs/promises";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";
import { childElements, descendants } from "../dom.js";
import { digest, hex } from "../engine.js";
import { NO_TRUST_LIST } from "../timestamp.js";
import { parseXml, verifyXml } from "../xml.js";
import { type ListPointer, readTrustedList, TrustedServiceSchema, TSL_MIME } from "./tsl.js";

// Fetching and caching the EU trusted lists. The chain of custody, and where it stops:
// 1. The list of lists (LOTL) is fetched over HTTPS from the European Commission's published address. Its XML signature
//    must verify, and its signer must be one of the certificates the LOTL publishes for itself. The EU also publishes
//    those signing certificates in the Official Journal; that pinning is NOT done here, so the LOTL is as authentic as
//    its HTTPS origin. The README says so.
// 2. Each member state's list (Poland's by default, run by NCCert) is fetched from the location the LOTL names, and its
//    signature must verify under one of the certificates the LOTL names for it.
// 3. What both say is parsed into services and cached as JSON; the verifier reads only the cache, never the network.

export const LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";
const MAX_BYTES = 32 * 1024 * 1024;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const ListFactsSchema = z.object({
    territory: z.string(),
    location: z.string(),
    sequenceNumber: z.string(),
    issued: z.string(),
    nextUpdate: z.string(),
    // SHA-256 of the certificate that signed the list.
    signer: z.string(),
});

export const TrustCacheSchema = z.object({
    version: z.literal(1),
    fetchedAt: z.string(),
    lotl: ListFactsSchema,
    lists: z.array(ListFactsSchema.extend({ services: z.array(TrustedServiceSchema) })),
});
export type TrustCache = z.infer<typeof TrustCacheSchema>;

// The list of lists only over HTTPS: its origin is what vouches for it. A member state's list may be published over
// plain HTTP (Slovakia's is): its XML signature, checked against the certificates the list of lists names for it, is what
// vouches for that one.
const fetchXml = async (fetcher: Fetch, location: string, httpsOnly: boolean): Promise<Uint8Array> => {
    const url = new URL(location);
    if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) {
        throw new Error(`refusing a trusted list over ${url.protocol} (${location})`);
    }
    const response = await fetcher(url.href, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`${location} answered HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) {
        throw new Error(`${location} is larger than ${MAX_BYTES} bytes`);
    }
    return bytes;
};

const sha256Of = async (base64: string): Promise<string> => hex(await digest("SHA-256", new Uint8Array(Buffer.from(base64, "base64"))));

// The list's own enveloped signature must cover the whole document (URI "" or the root's Id) and verify, and its signer
// must be one of `allowed` (base64 DER). Answers the signer's SHA-256.
const verifyListSignature = async (bytes: Uint8Array, allowed: readonly string[], what: string): Promise<string> => {
    const document = parseXml(bytes);
    const root = document.documentElement;
    const signatures = childElements(root ?? undefined, "Signature");
    const rootId = root?.getAttribute("Id") ?? root?.getAttribute("ID") ?? "";
    const whole = signatures.length === 1 && descendants(signatures[0] ?? document, "Reference").some((reference) => ["", `#${rootId}`].includes(reference.getAttribute("URI") ?? "-"));
    if (!whole) {
        throw new Error(`${what}: expected exactly one signature over the whole list`);
    }
    const [result] = await verifyXml({ bytes, trust: NO_TRUST_LIST });
    if (result?.integrity !== "valid" || result.signer === undefined) {
        throw new Error(`${what}: its XML signature does not verify (${result?.integrityDetail ?? "no signature"})`);
    }
    const permitted = new Set(await Promise.all(allowed.map(sha256Of)));
    if (!permitted.has(result.signer.sha256)) {
        throw new Error(`${what}: signed by ${result.signer.subject}, which is not among the certificates the list of lists names for it`);
    }
    return result.signer.sha256;
};

export interface RefreshOptions {
    readonly fetcher: Fetch;
    readonly territories: readonly string[];
    readonly lotlUrl?: string;
    readonly now?: Date;
}

const memberList = async (fetcher: Fetch, pointers: readonly ListPointer[], territory: string): Promise<TrustCache["lists"][number]> => {
    const pointer = pointers.find((entry) => entry.territory === territory && entry.mimeType === TSL_MIME);
    if (pointer === undefined) {
        throw new Error(`the list of trusted lists names no XML trusted list for ${territory}`);
    }
    const bytes = await fetchXml(fetcher, pointer.location, false);
    const signer = await verifyListSignature(bytes, pointer.certificates, `the ${territory} trusted list`);
    const list = readTrustedList(parseXml(bytes));
    if (list.territory !== territory) {
        throw new Error(`${pointer.location} is the trusted list of ${list.territory}, not ${territory}`);
    }
    return { territory, location: pointer.location, sequenceNumber: list.sequenceNumber, issued: list.issued, nextUpdate: list.nextUpdate, signer, services: [...list.services] };
};

export interface Refreshed {
    readonly cache: TrustCache;
    // Territories asked for whose list could not be fetched or did not verify; the others are cached regardless.
    readonly failed: readonly { readonly territory: string; readonly error: string }[];
}

export const refreshTrustedLists = async (options: RefreshOptions): Promise<Refreshed> => {
    const location = options.lotlUrl ?? LOTL_URL;
    const lotlBytes = await fetchXml(options.fetcher, location, true);
    const lotl = readTrustedList(parseXml(lotlBytes));
    const own = lotl.pointers.filter((pointer) => pointer.territory === lotl.territory && pointer.mimeType === TSL_MIME).flatMap((pointer) => pointer.certificates);
    const lotlSigner = await verifyListSignature(lotlBytes, own, "the EU list of trusted lists");
    const lists: TrustCache["lists"] = [];
    const failed: { territory: string; error: string }[] = [];
    for (const territory of options.territories) {
        try {
            lists.push(await memberList(options.fetcher, lotl.pointers, territory));
        } catch (cause) {
            failed.push({ territory, error: errorMessage(cause) });
        }
    }
    if (lists.length === 0) {
        throw new Error(`no trusted list could be cached: ${failed.map((entry) => `${entry.territory}: ${entry.error}`).join("; ")}`);
    }
    return {
        cache: {
            version: 1,
            fetchedAt: (options.now ?? new Date()).toISOString(),
            lotl: { territory: lotl.territory, location, sequenceNumber: lotl.sequenceNumber, issued: lotl.issued, nextUpdate: lotl.nextUpdate, signer: lotlSigner },
            lists,
        },
        failed,
    };
};

export const writeTrustCache = async (path: string, cache: TrustCache): Promise<void> => await writeFileAtomic(path, JSON.stringify(cache), 0o600);

// The cached lists, or undefined when none were fetched yet (or the file is from another version of this code).
export const readTrustCache = async (path: string): Promise<TrustCache | undefined> => {
    const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (raw === undefined) {
        return undefined;
    }
    const parsed = TrustCacheSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
};
