import { resolveTxt } from "node:dns/promises";
import { TXT_MISSING_CODES, type TxtAnswer, txtLookupOf, txtRecordName } from "@intentic/sandbox-contract/s2s";
import { S2sAddressSchema, S2sDomainSchema, S2sFingerprintSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import type { JsonFile } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";

// THE OWN DOMAINS this sandbox claims (docs/architecture/messages.md, "Addresses"): each with the result of its last
// TXT check. A domain is in the identity document only while its record, `_intentic.<domain>`, names this sandbox's
// current key and host; a rotation therefore drops every domain until its record is updated and checked again.

const DomainRowSchema = z.object({
    domain: S2sDomainSchema,
    claimedAt: z.number().int(),
    // What the record named at the last check that matched; absent until one did.
    matched: z.object({ fingerprint: S2sFingerprintSchema, host: S2sAddressSchema }).optional(),
    checkedAt: z.number().int().optional(),
    // What the last check found instead, in words.
    problem: z.string().max(500).optional(),
});
export type DomainRow = z.infer<typeof DomainRowSchema>;

export const identityDomainsDocument = defineDocument({
    root: "history",
    path: "s2s/identity-domains.json",
    // The domains this sandbox's key answers for: a copy elsewhere has another key, so the records would not match there.
    portability: "identity",
    schema: z.object({ domains: z.array(DomainRowSchema) }),
});

export const openIdentityDomains = (path: string): JsonFile<{ domains: DomainRow[] }> =>
    openDocument(identityDomainsDocument, path, { fallback: () => ({ domains: [] }) });

// Whether a domain's last check matched this key and host.
export const verifiedFor = (row: DomainRow, fingerprint: string, host: string): boolean =>
    row.matched?.fingerprint === fingerprint && row.matched.host === host;

// One domain checked against what its record should say: the row as it stands after.
export const checkedRow = (row: DomainRow, answer: TxtAnswer, expected: { readonly fingerprint: string; readonly host: string }, at: number): DomainRow => {
    const { matched: _matched, problem: _problem, ...rest } = row;
    const checked: DomainRow = { ...rest, checkedAt: at };
    if (answer.kind === "failed") {
        return { ...checked, problem: `looking up ${txtRecordName(row.domain)} failed: ${answer.error}`.slice(0, 500) };
    }
    const lookup = answer.kind === "missing" ? { kind: "none" as const } : txtLookupOf(answer.records);
    if (lookup.kind !== "record") {
        const said = { none: "has no record of ours yet", invalid: "holds a record that does not read", conflict: "holds records naming two keys" }[lookup.kind];
        return { ...checked, problem: `${txtRecordName(row.domain)} ${said}` };
    }
    if (lookup.record.fingerprint !== expected.fingerprint) {
        return { ...checked, problem: `the record names key ${lookup.record.fingerprint}, not this sandbox's ${expected.fingerprint}` };
    }
    if (lookup.record.host !== expected.host) {
        return { ...checked, problem: `the record names host ${lookup.record.host}, not ${expected.host}` };
    }
    return { ...checked, matched: { fingerprint: expected.fingerprint, host: expected.host } };
};

// What node:dns throws carries the resolver's code (ENOTFOUND, ESERVFAIL…).
const DnsErrorSchema = z.object({ code: z.string() });

// node:dns's resolveTxt, as the lookup answers it: no such name or no TXT there is `missing`, anything else a failure.
export const nodeTxtResolver = async (name: string): Promise<TxtAnswer> => {
    try {
        return { kind: "records", records: await resolveTxt(name) };
    } catch (error) {
        const code = DnsErrorSchema.safeParse(error).data?.code;
        if (code !== undefined && TXT_MISSING_CODES.includes(code)) {
            return { kind: "missing" };
        }
        return { kind: "failed", error: code ?? String(error) };
    }
};
