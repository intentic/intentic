import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { argvSafeSecret } from "../sandbox/mint-sandbox.js";

// ACCOUNT-LEVEL credentials: what acts for a person from outside a browser. Everything else this platform accepts
// names one sandbox or one sign-in, so this file is the only place a non-session caller becomes a user.

// A leaked secret is worth finding, and a secret nobody can recognise is not findable: the prefix is what lets a
// scanner say "that is an intentic token" in a log, a paste or a repository.
export const API_TOKEN_PREFIX = "itk_";

// One scope exists. It is a list rather than a boolean because the second one will be a value in it, not a schema
// change, and because a route asks for the scope it needs by name rather than trusting whatever the token carries.
export const API_TOKEN_SCOPES = ["provision"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

// 32 base62 characters is ~190 bits, comfortably past the 128 that matters, and the alphabet is the one every other
// pasted secret here uses (mint-sandbox.ts: no `-`, so a leading character can never parse as a flag).
export const mintApiToken = (): string => `${API_TOKEN_PREFIX}${argvSafeSecret(32)}`;

/** The stored form. Never reversible: the digest IS the lookup key, exactly as it is for a sandbox's connect token. */
export const apiTokenDigest = (raw: string): string => sha256Hex(raw);

export interface VerifiedToken {
    readonly id: string;
    readonly userId: string;
    readonly email: string;
    readonly label: string;
    readonly scope: string;
}

// Written at most once a minute per token: enough to show the owner a token nothing uses, far short of an audit log,
// and cheap enough that a busy token does not turn every call into a write.
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Resolves a presented token to its owner, or undefined for anything that is not a live token with `scope`.
 *
 * Indexed by digest, so an unknown token costs one miss rather than a scan, and no secret is ever compared in JS.
 * A revoked row answers undefined and stays in the table, so a token that acted remains explicable after it stops.
 */
export const verifyApiToken = async (prisma: PrismaClient, presented: string, scope: ApiTokenScope): Promise<VerifiedToken | undefined> => {
    if (presented === "") {
        return undefined;
    }
    const row = await prisma.apiToken.findUnique({
        where: { hash: apiTokenDigest(presented) },
        select: { id: true, userId: true, label: true, scope: true, revokedAt: true, lastUsedAt: true, user: { select: { email: true } } },
    });
    if (row === null || row.revokedAt !== null || row.scope !== scope) {
        return undefined;
    }
    const now = Date.now();
    if (row.lastUsedAt === null || now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
        // Never this caller's wait, and never this caller's failure: a token that worked worked, whatever the write did.
        void prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } }).catch(() => undefined);
    }
    return { id: row.id, userId: row.userId, email: row.user.email.toLowerCase(), label: row.label, scope: row.scope };
};

/** The `Authorization: Bearer …` value, or "" when the header is absent or shaped like anything else. */
export const bearerOf = (header: string | undefined): string => {
    if (header === undefined) {
        return "";
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() ?? "";
};
