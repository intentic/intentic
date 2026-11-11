import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { ORPCError } from "@orpc/server";
import { contributionDiscriminator, type KeyRequest, type KeyRequestAttribute } from "@intentic/extension-manifest";
import type { CertificateRequest as CertificateRequestAnswer, CertificateRequestInput } from "@intentic/sandbox-contract/schemas/certificate-request";
import { contributionFor, expandFieldTemplate, type ResolvedContribution } from "../contributions.js";
import { CertificateRequestRefusal, makeCertificateRequest } from "./certificate-request.js";
import type { SecretStash } from "./secret-stash.js";

// Which card field a certificate request is made for, and the subject its answers fill in: the route that makes the key
// (capabilities.certificateRequest) asks here, so it only ever makes one for a field that declares `keyRequest`, and
// fills the subject from the card's own templates rather than from words the caller chose.

// The declaration on the card the request names: a contributed card's by its provider, else the built-in tile's.
const declaredKeyRequest = (registry: ReadonlyMap<string, ResolvedContribution>, input: CertificateRequestInput): KeyRequest | undefined => {
    const discriminator = contributionDiscriminator(input.kind);
    const contributed = discriminator === undefined ? undefined : contributionFor(registry, input.kind, { [discriminator]: input.provider ?? "" });
    const fields = contributed?.spec.fields ?? CAPABILITY_CATALOG.filter((entry) => entry.kind === input.kind).flatMap((entry) => entry.fields);
    return fields.find((field) => field.key === input.field && field.keyRequest !== undefined)?.keyRequest;
};

// The subject, each attribute's template filled from the form's answers; empty ones are left to the request to drop.
const requestSubject = (keyRequest: KeyRequest, values: Readonly<Record<string, string>>): Partial<Record<KeyRequestAttribute, string>> =>
    Object.fromEntries(Object.entries(keyRequest.subject).map(([attribute, template]) => [attribute, expandFieldTemplate(template, values).trim()]));

// Makes the key and its request for the field the input names, and holds the key under a token bound to that card's
// field (and, for a kind several cards share, to that card), so it is installed nowhere else. A field that declares no
// `keyRequest`, or a subject the request cannot carry, is the form's to fix: answered as a bad request, in words.
export const certificateRequestFor = async (
    registry: ReadonlyMap<string, ResolvedContribution>,
    stash: SecretStash,
    input: CertificateRequestInput,
): Promise<CertificateRequestAnswer> => {
    const declared = declaredKeyRequest(registry, input);
    if (declared === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `no card here makes a certificate request for its "${input.field}"` });
    }
    let made: Awaited<ReturnType<typeof makeCertificateRequest>>;
    try {
        made = await makeCertificateRequest(requestSubject(declared, input.values));
    } catch (error) {
        throw error instanceof CertificateRequestRefusal ? new ORPCError("BAD_REQUEST", { message: error.message }) : error;
    }
    const binding = input.provider === undefined ? undefined : { provider: input.provider };
    return { request: made.request, subject: made.subject, token: stash.put({ kind: input.kind, field: input.field, value: made.privateKey, binding }) };
};
