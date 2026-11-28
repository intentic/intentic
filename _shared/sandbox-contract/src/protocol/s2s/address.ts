import type { JsonValue } from "@intentic/base/json";
import {
    S2S_TXT_LABEL,
    S2sAddressSchema,
    S2sDomainSchema,
    S2sFingerprintSchema,
    type S2sTxtRecord,
    type SandboxIdentity,
    SandboxIdentitySchema,
} from "../../schemas/s2s-identity.js";
import { speaksS2s, verifyIdentity } from "./identity-doc.js";

// ADDRESSES (docs/architecture/messages.md, "Addresses"): a contact is addressed by its sandbox host or by an own domain
// whose TXT record, `_intentic.<domain>` = `v=isk1 fp=<fingerprint> host=<host>`, says which key speaks for it and
// where. Resolving one takes its I/O as arguments (a DNS lookup, an HTTPS fetch), so every path is testable.

// The TXT record's version word.
const TXT_VERSION = "isk1";

// An address as a person or a document wrote it, in the one spelling this protocol compares: lowercase, punycode, no
// scheme, path, credentials or trailing dot, and no port 443. Undefined for anything that is no host.
export const normalizeAddress = (raw: string): string | undefined => {
    const text = raw.trim().replace(/^https?:\/\//iu, "").split("/")[0] ?? "";
    if (text === "" || text.includes("@")) {
        return undefined;
    }
    let host: string;
    try {
        const url = new URL(`https://${text}`);
        host = `${url.hostname.replace(/\.$/u, "")}${url.port === "" ? "" : `:${url.port}`}`;
    } catch {
        // allow(silent-catch): the URL parser refusing it is the answer: it is no host.
        return undefined;
    }
    return S2sAddressSchema.safeParse(host).success ? host : undefined;
};

// An own domain: an address with no port that is not localhost.
export const normalizeDomain = (raw: string): string | undefined => {
    const address = normalizeAddress(raw);
    return address !== undefined && S2sDomainSchema.safeParse(address).success ? address : undefined;
};

// Where a domain's record is published.
export const txtRecordName = (domain: string): string => `${S2S_TXT_LABEL}.${domain}`;

// The record's value, as the Identity section shows it to publish.
export const formatTxtRecord = ({ fingerprint, host }: S2sTxtRecord): string => `v=${TXT_VERSION} fp=${fingerprint} host=${host}`;

// One record's value, or undefined when it is not one of ours or does not read: `key=value` words in any order,
// separated by whitespace, `v=isk1` among them, a fingerprint and a host. A word this build does not know is skipped,
// for a later version's sake; a word twice, or one without `=`, spoils the record.
export const parseTxtRecord = (text: string): S2sTxtRecord | undefined => {
    const fields = new Map<string, string>();
    for (const word of text.trim().split(/\s+/u)) {
        const at = word.indexOf("=");
        if (at <= 0 || fields.has(word.slice(0, at).toLowerCase())) {
            return undefined;
        }
        fields.set(word.slice(0, at).toLowerCase(), word.slice(at + 1));
    }
    if (fields.get("v") !== TXT_VERSION) {
        return undefined;
    }
    const fingerprint = fields.get("fp")?.toLowerCase();
    const host = normalizeAddress(fields.get("host") ?? "");
    return fingerprint !== undefined && S2sFingerprintSchema.safeParse(fingerprint).success && host !== undefined ? { fingerprint, host } : undefined;
};

const isOurs = (text: string): boolean => /(?:^|\s)v=isk1(?:\s|$)/iu.test(text.trim());

// What a domain's TXT records say. `none`: no record of ours. `record`: one, or several that agree. `invalid`: one of ours
// does not read. `conflict`: ours name two different keys or hosts. Each record arrives as DNS chunks, joined first.
export type TxtLookup =
    | { readonly kind: "none" }
    | { readonly kind: "record"; readonly record: S2sTxtRecord }
    | { readonly kind: "invalid" | "conflict" };

export const txtLookupOf = (records: readonly (readonly string[])[]): TxtLookup => {
    const ours = records.map((chunks) => chunks.join("")).filter(isOurs);
    if (ours.length === 0) {
        return { kind: "none" };
    }
    const parsed = ours.map(parseTxtRecord);
    const [first] = parsed;
    if (first === undefined || parsed.some((record) => record === undefined)) {
        return { kind: "invalid" };
    }
    return parsed.every((record) => record?.fingerprint === first.fingerprint && record.host === first.host) ? { kind: "record", record: first } : { kind: "conflict" };
};

// The DNS error codes that mean the name has no record, not that the lookup failed (node:dns resolveTxt).
export const TXT_MISSING_CODES: readonly string[] = ["ENOTFOUND", "ENODATA"];

// The lookup, as the caller's resolver answered it: the records, none at all, or a failure in words.
export type TxtAnswer =
    | { readonly kind: "records"; readonly records: readonly (readonly string[])[] }
    | { readonly kind: "missing" }
    | { readonly kind: "failed"; readonly error: string };

// GET https://<host>/s2s/identity, as the caller fetched it: the JSON it answered, or the status and why not.
export type FetchedIdentity =
    | { readonly ok: true; readonly body: JsonValue }
    | { readonly ok: false; readonly status?: number | undefined; readonly error: string };

export interface AddressIo {
    readonly resolveTxt: (name: string) => Promise<TxtAnswer>;
    readonly fetchIdentity: (host: string) => Promise<FetchedIdentity>;
}

// Why an address did not resolve. invalid_address: no host. dns: the lookup failed. txt: its record does not read or
// names two keys. unreachable: the host did not answer. too_old: it answers but speaks no s2s/1 (401 is what a daemon
// from before answers this door). malformed: what it answered is no identity document. signature: the document does not
// verify. fingerprint: its key is not the one the record names. host: it is another host's document. domain: the
// document does not list the domain it was resolved for.
export const RESOLVE_REFUSALS = ["invalid_address", "dns", "txt", "unreachable", "too_old", "malformed", "signature", "fingerprint", "host", "domain"] as const;
export type ResolveRefusal = (typeof RESOLVE_REFUSALS)[number];

export type ResolvedAddress =
    | {
          readonly ok: true;
          // The address as normalized: what a contact is filed under.
          readonly address: string;
          // Where /s2s/* answers for it.
          readonly host: string;
          readonly document: SandboxIdentity;
          // The domain's record, when it had one.
          readonly txt?: S2sTxtRecord | undefined;
      }
    | { readonly ok: false; readonly code: ResolveRefusal; readonly message: string };

const refused = (code: ResolveRefusal, message: string): ResolvedAddress => ({ ok: false, code, message });

// A host with a port, or localhost, can be no domain, so it has no record to look up.
const mayHaveRecord = (address: string): boolean => S2sDomainSchema.safeParse(address).success;

const recordFor = async (address: string, io: AddressIo): Promise<S2sTxtRecord | ResolvedAddress | undefined> => {
    if (!mayHaveRecord(address)) {
        return undefined;
    }
    const answer = await io.resolveTxt(txtRecordName(address));
    if (answer.kind === "failed") {
        return refused("dns", `looking up ${txtRecordName(address)} failed: ${answer.error}`);
    }
    const lookup = answer.kind === "missing" ? ({ kind: "none" } as const) : txtLookupOf(answer.records);
    if (lookup.kind === "invalid" || lookup.kind === "conflict") {
        return refused("txt", `${txtRecordName(address)} ${lookup.kind === "invalid" ? "holds a record that does not read" : "names two different keys"}`);
    }
    return lookup.kind === "record" ? lookup.record : undefined;
};

const documentProblem = (document: SandboxIdentity, address: string, host: string, txt: S2sTxtRecord | undefined): ResolvedAddress | undefined => {
    const check = verifyIdentity(document);
    if (!check.ok) {
        return refused("signature", `${host} serves an identity that does not verify: ${check.reason}`);
    }
    if (!speaksS2s(document)) {
        return refused("too_old", `${host} does not speak s2s/1`);
    }
    if (normalizeAddress(document.host) !== host) {
        return refused("host", `${host} serves the identity of ${document.host}`);
    }
    if (txt !== undefined && document.fingerprint !== txt.fingerprint) {
        return refused("fingerprint", `${host} serves key ${document.fingerprint}, not the ${txt.fingerprint} that ${txtRecordName(address)} names`);
    }
    if (address !== host && !document.domains.includes(address)) {
        return refused("domain", `${host} does not list ${address} among its own domains`);
    }
    return undefined;
};

// Resolves an address to a verified identity: its record, when it has one, names the host and the key; without one the
// address is the host. The document must verify, be that host's, carry the record's key, and list the domain.
export const resolveAddress = async (raw: string, io: AddressIo): Promise<ResolvedAddress> => {
    const address = normalizeAddress(raw);
    if (address === undefined) {
        return refused("invalid_address", `"${raw.slice(0, 80)}" is no sandbox host or domain`);
    }
    const record = await recordFor(address, io);
    if (record !== undefined && "ok" in record) {
        return record;
    }
    const host = record?.host ?? address;
    const fetched = await io.fetchIdentity(host);
    if (!fetched.ok) {
        return fetched.status === 401 ? refused("too_old", `${host} answers no s2s/1: its daemon is from before it`) : refused("unreachable", `${host} did not answer: ${fetched.error}`);
    }
    const parsed = SandboxIdentitySchema.safeParse(fetched.body);
    if (!parsed.success) {
        return refused("malformed", `${host} answered something that is no identity document`);
    }
    return documentProblem(parsed.data, address, host, record) ?? { ok: true, address, host, document: parsed.data, txt: record };
};
