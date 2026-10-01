import { createPrivateKey, createPublicKey, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { ImageDataUrlSchema, type SandboxStanding } from "@intentic/api-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import { z } from "zod";
import { verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import { SANDBOX_ID, sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { encryptSecret } from "../crypto.js";
import { connectTokenIdentity } from "./mint-sandbox.js";
import { ingressEnabled, sandboxHostname } from "./reachability.js";

// WHEN THE PLATFORM FORGETS (docs/architecture/platform.md). A registry that lost a sandbox's row (a restore, a wrong
// DATABASE_URL) must not read the loss as a deletion, because everything downstream of it acts on the difference: the
// edge refuses tunnels, the editor shows onboarding, a daemon stops registering. Three facts carry it:
// - this database's identity, so a client can tell a registry that forgot it from the one it registered with;
// - the deletion records the `sandbox` trigger writes (SandboxTombstone), so "deleted" is recorded, never inferred;
// - adoption, the one way a sandbox the registry has no row for gets one back: its owner asks from a browser signed in
//   here, the daemon presents the grant this platform signed for its token, and the row is made again.

export interface PlatformIdentity {
    readonly identity: string;
    readonly since: Date;
}

// Read on every call rather than held: the identity is what tells a process its connection moved to another database,
// which a cached copy would hide. Recreated only if the row was deleted, which makes it a new identity, as it should.
export const readPlatformIdentity = async (prisma: PrismaClient): Promise<PlatformIdentity> => {
    const held = await prisma.platformIdentity.findUnique({ where: { id: 1 } });
    const row = held ?? (await prisma.platformIdentity.upsert({ where: { id: 1 }, create: { id: 1, identity: randomUUID() }, update: {} }));
    return { identity: row.identity, since: row.createdAt };
};

// The identity an accepted daemon call answers with, when the database can say: it tells the daemon which registry took
// it, which is worth a field and never worth failing the call over.
export const identityField = async (prisma: PrismaClient): Promise<{ identity?: string }> =>
    readPlatformIdentity(prisma).then(
        (held) => ({ identity: held.identity }),
        () => ({}),
    );

// The pin (DATABASE_EXPECTED_IDENTITY): a deployment that names its database refuses to serve any other, before it
// answers anyone. Unpinned, every database is accepted, which is what a developer's reset database needs.
export const identityRefusal = (expected: string, actual: PlatformIdentity): string | undefined =>
    expected === `` || expected === actual.identity
        ? undefined
        : `DATABASE_URL reaches database ${actual.identity}, but this platform is pinned to ${expected}: refusing to serve a registry that is not its own`;

// What a booting platform does about the database it found: serve it, serve it with a warning (unpinned, and it cannot
// say which it is), or refuse to start (pinned, and it is another one or cannot say).
export type BootIdentity =
    | { readonly kind: `serve`; readonly identity: PlatformIdentity }
    | { readonly kind: `unknown`; readonly reason: string }
    | { readonly kind: `refuse`; readonly reason: string };

export const bootIdentityOf = async (prisma: PrismaClient, expected: string): Promise<BootIdentity> => {
    let identity: PlatformIdentity;
    try {
        identity = await readPlatformIdentity(prisma);
    } catch (error) {
        const why = `the database's identity cannot be read (${errorMessage(error)})`;
        return expected === ``
            ? { kind: `unknown`, reason: `${why}: are its migrations applied?` }
            : { kind: `refuse`, reason: `${why}, and this platform is pinned to one: refusing to start` };
    }
    const refusal = identityRefusal(expected, identity);
    return refusal === undefined ? { kind: `serve`, identity } : { kind: `refuse`, reason: refusal };
};

// How often a running platform re-reads which database it is on. A connection that moved to another Postgres under a
// live process (a port taken over, a failover to the wrong cluster) is caught within this.
const IDENTITY_WATCH_MS = 60_000;

// The process's own pin, for its lifetime: the identity it booted on. A different one later means the database under
// it changed, and `onChange` is told once (the api exits, so it never serves a registry it did not boot on). A read
// that fails is not a change: the database being briefly unreachable says nothing about which one it is.
export const watchPlatformIdentity = (
    prisma: PrismaClient,
    booted: PlatformIdentity,
    onChange: (now: PlatformIdentity) => void,
    everyMs = IDENTITY_WATCH_MS,
): (() => void) => {
    let told = false;
    const timer = setInterval(() => {
        void readPlatformIdentity(prisma).then(
            (now) => {
                if (!told && now.identity !== booted.identity) {
                    told = true;
                    onChange(now);
                }
            },
            () => undefined,
        );
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
};

// Whether this tunnel id was let go of on purpose: a deleted row, or the old id of a rotated token.
export const isTombstoned = async (prisma: PrismaClient, tunnelId: string): Promise<boolean> =>
    (await prisma.sandboxTombstone.findUnique({ where: { tunnelId }, select: { tunnelId: true } })) !== null;

// What the registry holds of each 12-hex id the caller names, for the editor's recovery screen. `yours` only for the
// caller's own row: a share that is gone from the list is not the member's to bring back.
export const standingsOf = async (
    prisma: PrismaClient,
    userId: string,
    sandboxIds: readonly string[],
): Promise<{ sandboxId: string; standing: SandboxStanding; id?: string }[]> => {
    const ids = [...new Set(sandboxIds)].filter((id) => SANDBOX_ID.test(id));
    const [rows, tombstones] = await Promise.all([
        prisma.sandbox.findMany({ where: { tunnelId: { in: ids } }, select: { id: true, tunnelId: true, ownerId: true } }),
        prisma.sandboxTombstone.findMany({ where: { tunnelId: { in: ids } }, select: { tunnelId: true } }),
    ]);
    const deleted = new Set(tombstones.map((tombstone) => tombstone.tunnelId));
    return ids.map((sandboxId) => {
        const row = rows.find((entry) => entry.tunnelId === sandboxId);
        if (row !== undefined) {
            return row.ownerId === userId ? { sandboxId, standing: `yours`, id: row.id } : { sandboxId, standing: `other` };
        }
        return { sandboxId, standing: deleted.has(sandboxId) ? `deleted` : `unknown` };
    });
};

// The owner's say-so for one adoption: which sandbox, for which account, until when. Signed with the grant's own
// Ed25519 key under a prefix of its own (as owner-ticket.ts is), but read only by this platform; the daemon carries it
// opaque. Long enough for the browser to hand it over and the daemon to spend it; replaying it inside the window
// adopts nothing twice, since an adopted id answers `already` or a conflict.
const ADOPTION_PREFIX = `at1`;
export const ADOPTION_TICKET_TTL_MS = 10 * 60_000;

// The signed payload as it travels: the sandbox, the account and the expiry, in seconds like the grant's.
const AdoptionClaimWireSchema = z.object({ sub: z.string().regex(SANDBOX_ID), uid: z.string().min(1), exp: z.number() });

export interface AdoptionClaim {
    readonly sandboxId: string;
    readonly userId: string;
    readonly expiresAt: number;
}

export const mintAdoptionTicket = (privateKeyPem: string, claim: { readonly sandboxId: string; readonly userId: string; readonly issuedAtMs: number }): string => {
    if (!SANDBOX_ID.test(claim.sandboxId)) {
        throw new Error(`an adoption ticket names a 12-hex sandbox id, got "${claim.sandboxId}"`);
    }
    const iat = Math.floor(claim.issuedAtMs / 1000);
    const exp = Math.floor((claim.issuedAtMs + ADOPTION_TICKET_TTL_MS) / 1000);
    const payload = Buffer.from(JSON.stringify({ sub: claim.sandboxId, uid: claim.userId, iat, exp }), `utf8`);
    const signature = edSign(null, payload, createPrivateKey(privateKeyPem));
    return `${ADOPTION_PREFIX}.${payload.toString(`base64url`)}.${signature.toString(`base64url`)}`;
};

// Undefined for any way of being invalid: another prefix, a signature this key did not make, a malformed claim, expired.
export const verifyAdoptionTicket = (publicKeyPem: string, ticket: string, nowMs: number): AdoptionClaim | undefined => {
    const parts = ticket.split(`.`);
    if (parts.length !== 3 || parts[0] !== ADOPTION_PREFIX) {
        return undefined;
    }
    try {
        const payload = Buffer.from(parts[1] ?? ``, `base64url`);
        if (!edVerify(null, payload, createPublicKey(publicKeyPem), Buffer.from(parts[2] ?? ``, `base64url`))) {
            return undefined;
        }
        const parsed = AdoptionClaimWireSchema.safeParse(JSON.parse(payload.toString(`utf8`)));
        if (!parsed.success || parsed.data.exp * 1000 <= nowMs) {
            return undefined;
        }
        return { sandboxId: parsed.data.sub, userId: parsed.data.uid, expiresAt: parsed.data.exp * 1000 };
    } catch {
        // allow(silent-catch): a ticket that does not parse is one of the ways of being invalid, answered as undefined.
        return undefined;
    }
};

// What a daemon sends to be adopted (POST /sandbox/adopt): its connect token rides the header, as on every daemon route.
export interface AdoptionRequest {
    readonly token: string;
    readonly ticket: string;
    readonly grant: string;
    readonly daemonUrl: string;
    // The owner the daemon bound, as it knows them; adoption makes them the row's owner here, so they must be one.
    readonly owner: string | undefined;
    readonly name: string | undefined;
    readonly image: string | undefined;
    readonly version: string | null;
}

export type AdoptionVerdict =
    | { readonly kind: `adopted` | `already`; readonly sandboxId: string }
    | { readonly kind: `refused`; readonly status: 400 | 401 | 403 | 404 | 409 | 410; readonly message: string };

const refused = (status: 400 | 401 | 403 | 404 | 409 | 410, message: string): AdoptionVerdict => ({ kind: `refused`, status, message });

// The name a row comes back under: the one the owner's browser remembered, else a plain one they can rename.
const adoptedName = (name: string | undefined): string => {
    const trimmed = name?.trim() ?? ``;
    return trimmed === `` ? `Recovered sandbox` : trimmed.slice(0, 60);
};

// Who already holds the id, read again after a lost race on the unique columns: the same owner's concurrent adoption
// is this one's answer, anything else the conflict it is.
const heldAnswer = async (prisma: PrismaClient, tunnelId: string, userId: string, tokenDigest: string): Promise<AdoptionVerdict | undefined> => {
    const held = await prisma.sandbox.findUnique({ where: { tunnelId }, select: { id: true, ownerId: true, tokenDigest: true } });
    if (held === null) {
        return undefined;
    }
    return held.ownerId === userId && held.tokenDigest === tokenDigest
        ? { kind: `already`, sandboxId: held.id }
        : refused(409, `this sandbox is registered to another account`);
};

// Checks, cheapest and most telling first: the platform can vouch at all; the ticket is ours, live and for this
// sandbox; the grant is ours and for this token; the address is the one this token derives; the daemon's owner is the
// account that asked. Then the registry: a row already there (ours: done; anyone else's: a conflict), or a deletion
// record (refused: deleting is how an owner says they are finished with it), else the row is made again.
export const adoptSandbox = async (prisma: PrismaClient, config: Config, request: AdoptionRequest, nowMs: number): Promise<AdoptionVerdict> => {
    if (!ingressEnabled(config)) {
        return refused(404, `this platform hands out no addresses, so it cannot vouch for a sandbox: connect it by its address instead`);
    }
    const publicKey = publicKeyPemOf(config.ingress.signingKey);
    const claim = verifyAdoptionTicket(publicKey, request.ticket, nowMs);
    if (claim === undefined) {
        return refused(401, `the adoption ticket is invalid or expired: press Reconnect again`);
    }
    const tunnelId = sandboxIdFromToken(request.token);
    if (tunnelId === undefined || claim.sandboxId !== tunnelId) {
        return refused(403, `this adoption ticket is for another sandbox`);
    }
    if (verifyReachabilityGrant(publicKey, request.grant)?.sandboxId !== tunnelId) {
        return refused(403, `this sandbox's grant was not signed by this platform`);
    }
    if (new URL(request.daemonUrl).host !== sandboxHostname(config.ingress.zone, request.token)) {
        return refused(400, `this sandbox answers at ${sandboxHostname(config.ingress.zone, request.token)}, not ${new URL(request.daemonUrl).host}`);
    }
    const user = await prisma.user.findUnique({ where: { id: claim.userId }, select: { email: true } });
    if (user === null) {
        return refused(401, `the account that asked for this adoption no longer exists`);
    }
    if (request.owner === undefined || request.owner.toLowerCase() !== user.email.toLowerCase()) {
        return refused(403, `this sandbox's owner is not the account that asked to reconnect it`);
    }
    const tokenDigest = sha256Hex(request.token);
    const held = await heldAnswer(prisma, tunnelId, claim.userId, tokenDigest);
    if (held !== undefined) {
        return held;
    }
    if (await isTombstoned(prisma, tunnelId)) {
        return refused(410, `this sandbox was deleted from intentic: restore it from the trash, or set up a new one`);
    }
    const now = new Date(nowMs);
    const data: Prisma.SandboxUncheckedCreateInput = {
        name: adoptedName(request.name),
        ownerId: claim.userId,
        token: encryptSecret(config, request.token),
        ...connectTokenIdentity(request.token),
        daemonUrl: request.daemonUrl,
        daemonVersion: request.version,
        lastSeenAt: now,
        firstAnnouncedAt: now,
    };
    // The logo the owner's browser remembered, when it is one; a malformed one is left behind rather than refusing.
    const image = ImageDataUrlSchema.safeParse(request.image);
    if (image.success) {
        data.image = image.data;
    }
    try {
        const row = await prisma.sandbox.create({ data, select: { id: true } });
        return { kind: `adopted`, sandboxId: row.id };
    } catch (error) {
        // Two adoptions of one sandbox raced on the unique columns; the winner's row is the answer for both.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === `P2002`) {
            return (await heldAnswer(prisma, tunnelId, claim.userId, tokenDigest)) ?? refused(409, `this sandbox is registered to another account`);
        }
        throw error;
    }
};
