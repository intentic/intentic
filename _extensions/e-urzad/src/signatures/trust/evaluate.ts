import { Certificate, CertificateChainValidationEngine, ChainValidationCode, ChainValidationError } from "pkijs";
import { derOf, validAt } from "../certificate.js";
import { digest, hex } from "../engine.js";
import { TRUST_NOT_CHECKED, type TrustFacts } from "../report.js";
import type { TrustEvaluator } from "../timestamp.js";
import type { TrustCache } from "./lists.js";
import { SERVICE_TYPE, statusAt, type TrustedService } from "./tsl.js";

// Trust against the cached trusted lists: build a certificate path from the signer (with the certificates the signature
// carries) to a certificate a trusted-list service publishes as its digital identity, with PKI.js checking every
// signature on the way and each certificate's validity at the moment in question (the time-stamp's time, else the
// claimed signing time, else now). Then the service's status at that moment, from its history. Revocation is not
// consulted: no OCSP or CRL request is made, and the report says so on every answer.

interface Anchor {
    readonly certificate: Certificate;
    readonly service: TrustedService;
}

const loadAnchors = async (cache: TrustCache): Promise<Map<string, Anchor>> => {
    const anchors = new Map<string, Anchor>();
    for (const list of cache.lists) {
        for (const service of list.services) {
            for (const encoded of service.certificates) {
                const der = new Uint8Array(Buffer.from(encoded, "base64"));
                const key = hex(await digest("SHA-256", der));
                if (!anchors.has(key)) {
                    anchors.set(key, { certificate: Certificate.fromBER(der), service });
                }
            }
        }
    }
    return anchors;
};

const describeList = (cache: TrustCache): string =>
    `EU list of trusted lists #${cache.lotl.sequenceNumber} → ${cache.lists.map((list) => `${list.territory} trusted list #${list.sequenceNumber}`).join(", ")} (fetched ${cache.fetchedAt})`;

const expectedType = (purpose: "signer" | "timestamp"): string => (purpose === "signer" ? SERVICE_TYPE.caQualified : SERVICE_TYPE.timestampQualified);

const typeName = (type: string): string => type.split("/Svctype/")[1] ?? type;

// PKI.js's codes for "no path reaches a trusted certificate", as opposed to a path that does and fails a check on the way.
const NO_PATH = new Set<number>([ChainValidationCode.noPath, ChainValidationCode.noValidPath]);

const noPathFound = (result: { readonly resultCode: number; readonly resultMessage: string }): boolean =>
    NO_PATH.has(result.resultCode) ||
    // allow(dependency-text): pkijs; its path builder throws a code-less Error at a certificate with no known issuer, read as `unknown`, so only its words say "no path"; any other wording reports chain-invalid with PKI.js's message.
    (result.resultCode === ChainValidationCode.unknown && /No valid certificate paths/i.test(result.resultMessage));

const anchoredAt = (anchor: Anchor, checkDate: Date, purpose: "signer" | "timestamp", base: Pick<TrustFacts, "revocation" | "checkedAt" | "trustedList">): TrustFacts => {
    const status = statusAt(anchor.service, checkDate) ?? "no status at that time";
    const wanted = anchor.service.type === expectedType(purpose);
    return {
        ...base,
        status: "anchored",
        detail: `chains to "${anchor.service.name}" (${anchor.service.provider}, ${anchor.service.territory}), a ${typeName(anchor.service.type)} service with status ${status.split("/").at(-1) ?? status} at ${checkDate.toISOString()}${wanted ? "" : `; not the ${typeName(expectedType(purpose))} type this ${purpose} needs`}`,
        service: { name: anchor.service.name, provider: anchor.service.provider, territory: anchor.service.territory, type: anchor.service.type, status, qualifiers: anchor.service.qualifiers },
    };
};

export const trustListEvaluator = (cache: TrustCache | undefined): TrustEvaluator => {
    if (cache === undefined || cache.lists.length === 0) {
        return { evaluate: () => Promise.resolve(TRUST_NOT_CHECKED) };
    }
    let anchors: Promise<Map<string, Anchor>> | undefined;
    const trustedList = describeList(cache);
    return {
        evaluate: async (certificate, bundle, at, purpose): Promise<TrustFacts> => {
            anchors ??= loadAnchors(cache);
            const known = await anchors;
            const checkDate = at ?? new Date();
            const base = { revocation: "not-checked" as const, checkedAt: checkDate.toISOString(), trustedList };
            // A certificate that is itself a service's digital identity (a TSA's, often) is the anchor: no path to build.
            const listed = known.get(hex(await digest("SHA-256", derOf(certificate))));
            if (listed !== undefined) {
                return validAt(certificate, checkDate)
                    ? anchoredAt(listed, checkDate, purpose, base)
                    : { ...base, status: "chain-invalid", detail: `the certificate is on the trusted list but not valid at ${checkDate.toISOString()}` };
            }
            const engine = new CertificateChainValidationEngine({ trustedCerts: [...known.values()].map((anchor) => anchor.certificate), certs: [certificate, ...bundle], checkDate });
            const result = await engine.verify().catch((cause: unknown) => ({
                result: false,
                resultCode: cause instanceof ChainValidationError ? cause.code : ChainValidationCode.unknown,
                resultMessage: cause instanceof Error ? cause.message : "path building failed",
                certificatePath: undefined,
            }));
            const path = result.certificatePath ?? [];
            const top = path.at(-1);
            if (!result.result || top === undefined) {
                const noPath = noPathFound(result);
                return {
                    ...base,
                    status: noPath ? "not-anchored" : "chain-invalid",
                    detail: noPath ? `no path from this certificate to any service on ${trustedList}` : `the path to the trusted list does not validate: ${result.resultMessage}`,
                };
            }
            const anchor = known.get(hex(await digest("SHA-256", derOf(top))));
            if (anchor === undefined) {
                return { ...base, status: "chain-invalid", detail: "the path ends at a certificate that is not on the cached trusted lists" };
            }
            return anchoredAt(anchor, checkDate, purpose, base);
        },
    };
};
