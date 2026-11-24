import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { SANDBOX_ID } from "../../ids/tunnel-ids.js";
import { PASS_SCOPES, type PassScope } from "./pass-scopes.js";

// The platform's signed word that one sandbox may report to another ON THE SAME ACCOUNT about one project: the
// credential behind account-level report routing. The sending daemon asks the platform who owns a project
// (`projectResolve`, authenticated by its connect token, so `from` is the platform's own reading, never the sender's
// claim); the platform answers with the owner's address and this pass; the receiving daemon checks it against the
// platform's identity key it already holds (the announce answer's `identityKey`). Signed with the same key as the
// identity assertion, under its own prefix, so neither can ever stand in for the other.

const PASS_PREFIX = "sp1";

// Long enough for an outbox to drain a few reports through one resolve; short enough that a lifted pass is soon dead.
export const SANDBOX_PASS_TTL_MS = 10 * 60_000;
// What a daemon accepts whatever the claim says, so a platform minting with a wrong ttl cannot hand out a long credential.
export const SANDBOX_PASS_MAX_TTL_MS = 15 * 60_000;

// The header a pass rides on the receiving daemon's `/account/` routes.
export const SANDBOX_PASS_HEADER = "x-intentic-sandbox-pass";
export { ROUTE_SECRET_HEADER } from "./pass-scopes.js";

// One side of a report that crossed an organisation's line: the organisation, by its platform id and the name its admins
// gave it. A side that belongs to none is left out.
export interface PassOrg {
    readonly id: string;
    readonly name: string;
}

// Set only when the two sandboxes do not belong to the same organisation (one personal and one bound, or two different
// organisations): the platform's word, so the receiver can say a report came across that line. Allowed, never refused.
export interface CrossesOrg {
    readonly from?: PassOrg;
    readonly to?: PassOrg;
}

// The scopes live in their own module, so a browser bundle can take them without this one's node:crypto.
export { PASS_SCOPES, type PassScope } from "./pass-scopes.js";

export interface SandboxPass {
    // The sending sandbox's tunnel id, and the name its owner gave it (for the inbox; display only).
    readonly from: string;
    readonly fromName: string;
    // The receiving sandbox's tunnel id: a daemon refuses a pass addressed to anyone else.
    readonly to: string;
    readonly scope: PassScope;
    // The normalized project id the receiver claims (project-id.ts): on a report pass, and only there.
    readonly project?: string;
    // The one person the request routes as (a lower-cased address), whom the platform found on both sandboxes' rosters:
    // always on a scope other than `report`, and on a report only when the sender could prove which conversation asked.
    readonly person?: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    // Present only when the report crosses an organisation's line.
    readonly crossesOrg?: CrossesOrg;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

// The prefix is part of what is signed: a pass is never a valid signature over an identity assertion, nor the reverse.
const signedBytes = (payload: Buffer): Buffer => Buffer.concat([Buffer.from(`${PASS_PREFIX}.`, "utf8"), payload]);

export const isSandboxPass = (token: string): boolean => token.startsWith(`${PASS_PREFIX}.`);

export const mintSandboxPass = (
    privateKeyPem: string,
    claim: {
        readonly from: string;
        readonly fromName: string;
        readonly to: string;
        readonly scope?: PassScope;
        readonly project?: string | undefined;
        readonly person?: string | undefined;
        readonly issuedAtMs: number;
        readonly ttlMs?: number;
        readonly crossesOrg?: CrossesOrg | undefined;
    },
): string => {
    if (!SANDBOX_ID.test(claim.from) || !SANDBOX_ID.test(claim.to)) {
        throw new Error("a sandbox pass names two 12-hex sandbox ids");
    }
    if (claim.from === claim.to) {
        throw new Error("a sandbox pass is from one sandbox to another");
    }
    const scope = claim.scope ?? "report";
    // A daemon from before scopes reads any pass with a project as a report, so only a report pass may carry one.
    if (scope === "report" ? (claim.project ?? "").trim() === "" : claim.project !== undefined) {
        throw new Error("a report pass names a project, and only a report pass does");
    }
    if (scope !== "report" && (claim.person ?? "").trim() === "") {
        throw new Error("a pass that routes as a person names the person");
    }
    const ttlMs = claim.ttlMs ?? SANDBOX_PASS_TTL_MS;
    if (ttlMs <= 0 || ttlMs > SANDBOX_PASS_MAX_TTL_MS) {
        throw new Error(`a sandbox pass lives at most ${SANDBOX_PASS_MAX_TTL_MS} ms`);
    }
    const payload = Buffer.from(
        JSON.stringify({
            v: 1,
            iss: claim.from,
            name: claim.fromName.slice(0, 120),
            aud: claim.to,
            prj: claim.project,
            // Left out for a report, so a report pass reads exactly as it did before scopes.
            scp: scope === "report" ? undefined : scope,
            sub: claim.person?.trim().toLowerCase(),
            iat: Math.floor(claim.issuedAtMs / 1000),
            exp: Math.floor((claim.issuedAtMs + ttlMs) / 1000),
            jti: base64url(randomBytes(12)),
            // JSON leaves an undefined key out, so a pass within one organisation carries no `org` at all.
            org: claim.crossesOrg === undefined ? undefined : orgClaim(claim.crossesOrg),
        }),
        "utf8",
    );
    const signature = edSign(null, signedBytes(payload), createPrivateKey(privateKeyPem));
    return `${PASS_PREFIX}.${base64url(payload)}.${base64url(signature)}`;
};

const clip = (org: PassOrg): PassOrg => ({ id: org.id.slice(0, 64), name: org.name.slice(0, 120) });
const orgClaim = (crosses: { readonly from?: PassOrg | undefined; readonly to?: PassOrg | undefined }): CrossesOrg => {
    if (crosses.from !== undefined && crosses.to !== undefined) {
        return { from: clip(crosses.from), to: clip(crosses.to) };
    }
    if (crosses.from !== undefined) {
        return { from: clip(crosses.from) };
    }
    return crosses.to === undefined ? {} : { to: clip(crosses.to) };
};

const PassOrgSchema = z.object({ id: z.string().min(1).max(64), name: z.string().max(120) });

// `org` is optional, so a pass minted before it (or by a platform that never sets it) verifies as it did, and a daemon
// from before it strips the key it does not know rather than refusing the pass.
const PassPayloadSchema = z.object({
    v: z.literal(1),
    iss: z.string().regex(SANDBOX_ID),
    name: z.string(),
    aud: z.string().regex(SANDBOX_ID),
    prj: z.string().min(1).optional(),
    // An unknown scope fails the parse, so a pass for a door this build does not know is refused rather than misread.
    scp: z.enum(PASS_SCOPES).optional(),
    sub: z.string().min(3).max(254).optional(),
    iat: z.number(),
    exp: z.number(),
    jti: z.string().min(1),
    org: z.object({ from: PassOrgSchema.optional(), to: PassOrgSchema.optional() }).optional(),
});

type PassPayload = z.infer<typeof PassPayloadSchema>;

// The payload a valid signature covers, parsed; undefined for a wrong prefix, a bad signature or a malformed claim.
const signedPayload = (publicKeyPem: string, token: string): PassPayload | undefined => {
    const [prefix, encodedPayload, encodedSignature, ...rest] = token.split(".");
    if (prefix !== PASS_PREFIX || encodedPayload === undefined || encodedSignature === undefined || rest.length > 0) {
        return undefined;
    }
    const payload = Buffer.from(encodedPayload, "base64url");
    try {
        if (!edVerify(null, signedBytes(payload), createPublicKey(publicKeyPem), Buffer.from(encodedSignature, "base64url"))) {
            return undefined;
        }
    } catch {
        // allow(silent-catch): a key or signature that does not parse verifies nothing: the pass is invalid, said as undefined.
        return undefined;
    }
    return parseJsonWith(payload.toString("utf8"), PassPayloadSchema);
};

// Live at nowMs, issued no later than a minute ahead of it, and living no longer than any pass may.
const timely = (claim: PassPayload, nowMs: number): boolean =>
    claim.exp * 1000 > nowMs && claim.iat * 1000 <= nowMs + 60_000 && (claim.exp - claim.iat) * 1000 <= SANDBOX_PASS_MAX_TTL_MS;

// A report names its project and nothing routes as a person without naming them; anything else is no pass at all.
const namesItsSubject = (claim: PassPayload): boolean =>
    (claim.scp ?? "report") === "report" ? claim.prj !== undefined : claim.prj === undefined && claim.sub !== undefined;

const passOf = (claim: PassPayload): SandboxPass => {
    const pass: SandboxPass = { from: claim.iss, fromName: claim.name, to: claim.aud, scope: claim.scp ?? "report", issuedAt: claim.iat, expiresAt: claim.exp };
    const withProject: SandboxPass = claim.prj === undefined ? pass : { ...pass, project: claim.prj };
    const withPerson: SandboxPass = claim.sub === undefined ? withProject : { ...withProject, person: claim.sub };
    return claim.org === undefined || (claim.org.from === undefined && claim.org.to === undefined) ? withPerson : { ...withPerson, crossesOrg: orgClaim(claim.org) };
};

// Verifies a pass against the platform's public key at nowMs; undefined for any way of being invalid (wrong prefix, bad
// signature, malformed claim, an unknown scope, expired, issued in the future, living longer than allowed). The caller
// checks `to` against its own id, the scope against its door, and `project` or `person` against its own records.
export const verifySandboxPass = (publicKeyPem: string, token: string, nowMs: number): SandboxPass | undefined => {
    const claim = signedPayload(publicKeyPem, token);
    if (claim === undefined || claim.iss === claim.aud || !timely(claim, nowMs) || !namesItsSubject(claim)) {
        return undefined;
    }
    return passOf(claim);
};
