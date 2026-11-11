import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { type CapabilityField, contributionDiscriminator } from "@intentic/extension-manifest";
import type { CertificateRequestInput } from "@intentic/sandbox-contract/schemas/certificate-request";
import type { FormValues } from "./form";

// A field declaring `keyRequest`: a key the sandbox makes, with only its certificate request shown
// (parts/capabilities/CertificateRequestField.vue). Which answers its subject is filled from, which of those are still
// empty, and what the sandbox is asked for. Plain functions over the tile and the form's values.

// `${field}` or `${field:uri}` in a subject template, as the sandbox fills it (contributions.ts `expandFieldTemplate`).
const TEMPLATE_FIELD = /\$\{([a-zA-Z][a-zA-Z0-9]*)(?::uri)?\}/gu;

// The fields the subject is filled from, in the tile's order: never a secret, since only these are sent.
export const subjectFields = (entry: CapabilityCatalogEntry, field: CapabilityField): readonly CapabilityField[] => {
    const named = new Set(Object.values(field.keyRequest?.subject ?? {}).flatMap((template) => [...template.matchAll(TEMPLATE_FIELD)].map((match) => match[1])));
    const seen = new Set<string>();
    return entry.fields.filter((candidate) => {
        if (!named.has(candidate.key) || candidate.secret === true || seen.has(candidate.key)) {
            return false;
        }
        seen.add(candidate.key);
        return true;
    });
};

// The subject's required answers still empty: the request waits for them, since its issuer reads every one.
export const unansweredSubject = (entry: CapabilityCatalogEntry, field: CapabilityField, values: Readonly<FormValues>): readonly CapabilityField[] =>
    subjectFields(entry, field).filter((candidate) => candidate.optional !== true && (values[candidate.key] ?? ``).trim() === ``);

// What the sandbox is asked for: the card (by kind, and by the id it pins for a kind several cards share), the field,
// and the subject's answers alone.
export const certificateRequestInput = (entry: CapabilityCatalogEntry, field: CapabilityField, values: Readonly<FormValues>): CertificateRequestInput => {
    const discriminator = contributionDiscriminator(entry.kind);
    const provider = discriminator === undefined ? undefined : entry.fields.find((candidate) => candidate.key === discriminator)?.value;
    return {
        kind: entry.kind,
        provider,
        field: field.key,
        values: Object.fromEntries(subjectFields(entry, field).map((candidate) => [candidate.key, (values[candidate.key] ?? ``).trim()])),
    };
};

// Where a request made for one form is kept in the operations ledger, as `sshKeyScope` keeps a key: by tile and by the
// connection being edited (`new` while adding one).
export const keyRequestScope = (entry: string, connection?: string): string =>
    connection === undefined ? `capabilities/${entry}/key-request` : `capabilities/${entry}/key-request/${connection}`;
