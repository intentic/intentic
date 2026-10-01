import { createHash, generateKeyPairSync } from "node:crypto";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import { mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { publicKeyPemOf } from "@intentic/sandbox-contract/owner-ticket";
import { unstubbed } from "@intentic/testing";
import { configSchema } from "../config.js";
import { INGRESS_TEST_PRIVATE_KEY, testIngressConfig } from "../testing.js";
import {
    ADOPTION_TICKET_TTL_MS,
    type AdoptionRequest,
    type AdoptionVerdict,
    type BootIdentity,
    adoptSandbox,
    bootIdentityOf,
    identityRefusal,
    mintAdoptionTicket,
    standingsOf,
    verifyAdoptionTicket,
    watchPlatformIdentity,
} from "./recovery.js";

// Pins what a registry that forgot a sandbox may and may not do: the pin refuses another database; a lookup says which
// ids are someone's, deleted or unknown; a ticket verifies only for its own key, prefix and window; and adoption makes a
// row only for an unknown id, with this platform's own grant, at the token's own address, for the daemon's own owner.

const config = configSchema.parse({
    database: { url: `postgres://x` },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    ingress: testIngressConfig,
});
const PUBLIC_KEY = publicKeyPemOf(INGRESS_TEST_PRIVATE_KEY);
const NOW = Date.parse(`2026-10-02T12:00:00.000Z`);

// The connect token `tok` and everything derived from it, by the shared digest rather than transcribed.
const TOKEN = `tok`;
const DIGEST = createHash(`sha256`).update(TOKEN).digest(`hex`);
const TUNNEL_ID = DIGEST.slice(0, 12);
const DAEMON_URL = `https://sandbox-${TUNNEL_ID}.${testIngressConfig.zone}`;

// One Prisma delegate, answering only the methods the module under test calls; `unstubbed` names any other it reaches.
// SAFETY: each method given here returns the rows its call selects, which is all the module reads off a delegate.
const delegate = <K extends keyof PrismaClient>(name: K, methods: Record<string, (...args: never[]) => Promise<object | null>>): PrismaClient[K] =>
    unstubbed<PrismaClient[K] & object>(`prisma.${String(name)}`, methods as Partial<PrismaClient[K] & object>);

const ticketFor = (sandboxId: string, userId = `u1`, issuedAtMs = NOW) =>
    mintAdoptionTicket(INGRESS_TEST_PRIVATE_KEY, { sandboxId, userId, issuedAtMs });

const request = (over: Partial<AdoptionRequest> = {}): AdoptionRequest => ({
    token: TOKEN,
    ticket: ticketFor(TUNNEL_ID),
    grant: mintReachabilityGrant(INGRESS_TEST_PRIVATE_KEY, TUNNEL_ID, NOW),
    daemonUrl: DAEMON_URL,
    owner: `Owner@Example.com`,
    name: `intentic`,
    image: undefined,
    version: `1.2.3`,
    ...over,
});

// The registry as adoption reads it: the asking account, at most one row holding the id, at most one deletion record.
const registry = (over: { user?: { email: string } | null; held?: { id: string; ownerId: string; tokenDigest: string } | null; tombstoned?: boolean } = {}) => {
    const create = jest.fn<(args: { data: object; select: object }) => Promise<{ id: string }>>(async () => ({ id: `adopted` }));
    const prisma = unstubbed<PrismaClient>(`prisma`, {
        user: delegate(`user`, { findUnique: async () => (over.user === undefined ? { email: `owner@example.com` } : over.user) }),
        sandbox: delegate(`sandbox`, { findUnique: async () => over.held ?? null, create }),
        sandboxTombstone: delegate(`sandboxTombstone`, { findUnique: async () => (over.tombstoned === true ? { tunnelId: TUNNEL_ID } : null) }),
    });
    return { prisma, create };
};

describe(`the identity pin`, () => {
    const identity = { identity: `a0028692-7cf2-4ef4-8429-86a98d60be8a`, since: new Date(NOW) };

    it(`accepts any database unpinned, and the pinned one`, () => {
        expect(identityRefusal(``, identity)).toBeUndefined();
        expect(identityRefusal(`a0028692-7cf2-4ef4-8429-86a98d60be8a`, identity)).toBeUndefined();
    });

    it(`refuses another database, naming both`, () => {
        expect(identityRefusal(`5f0e1c2b-0000-4000-8000-000000000000`, identity)).toBe(
            `DATABASE_URL reaches database a0028692-7cf2-4ef4-8429-86a98d60be8a, but this platform is pinned to 5f0e1c2b-0000-4000-8000-000000000000: refusing to serve a registry that is not its own`,
        );
    });
});

describe(`the database a platform boots on`, () => {
    const IDENTITY = `a0028692-7cf2-4ef4-8429-86a98d60be8a`;
    const answering = (read: () => Promise<object | null>) =>
        unstubbed<PrismaClient>(`prisma`, { platformIdentity: delegate(`platformIdentity`, { findUnique: read }) });
    const found = answering(async () => ({ id: 1, identity: IDENTITY, createdAt: new Date(NOW) }));
    const silent = answering(async () => {
        throw new Error(`relation "platform_identity" does not exist`);
    });

    it(`serves the database it found, unpinned or pinned to it`, async () => {
        const serve: BootIdentity = { kind: `serve`, identity: { identity: IDENTITY, since: new Date(NOW) } };
        expect(await bootIdentityOf(found, ``)).toEqual(serve);
        expect(await bootIdentityOf(found, IDENTITY)).toEqual(serve);
    });

    it(`refuses another database when pinned`, async () => {
        expect(await bootIdentityOf(found, `5f0e1c2b-0000-4000-8000-000000000000`)).toEqual({
            kind: `refuse`,
            reason: `DATABASE_URL reaches database ${IDENTITY}, but this platform is pinned to 5f0e1c2b-0000-4000-8000-000000000000: refusing to serve a registry that is not its own`,
        });
    });

    it(`serves with a warning when unpinned and the database cannot say, and refuses when pinned`, async () => {
        expect(await bootIdentityOf(silent, ``)).toEqual({
            kind: `unknown`,
            reason: `the database's identity cannot be read (relation "platform_identity" does not exist): are its migrations applied?`,
        });
        expect(await bootIdentityOf(silent, IDENTITY)).toEqual({
            kind: `refuse`,
            reason: `the database's identity cannot be read (relation "platform_identity" does not exist), and this platform is pinned to one: refusing to start`,
        });
    });
});

describe(`watching the database under a running platform`, () => {
    const booted = { identity: `booted`, since: new Date(NOW) };
    const reading = (answers: (string | Error)[]) => {
        const findUnique = jest.fn(async () => {
            const next = answers.shift() ?? `booted`;
            if (next instanceof Error) {
                throw next;
            }
            return { id: 1, identity: next, createdAt: new Date(NOW) };
        });
        return unstubbed<PrismaClient>(`prisma`, { platformIdentity: delegate(`platformIdentity`, { findUnique }) });
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

    it(`tells once, with the identity it found, when the database changes`, async () => {
        const onChange = jest.fn<(now: { identity: string; since: Date }) => void>();
        const stop = watchPlatformIdentity(reading([`booted`, `another`, `another`]), booted, onChange, 5);
        await settle();
        stop();
        expect(onChange.mock.calls).toEqual([[{ identity: `another`, since: new Date(NOW) }]]);
    });

    it(`reads an unreachable database as no change`, async () => {
        const onChange = jest.fn<(now: { identity: string; since: Date }) => void>();
        const stop = watchPlatformIdentity(reading([new Error(`connection refused`), new Error(`connection refused`)]), booted, onChange, 5);
        await settle();
        stop();
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe(`what the registry holds of ids the editor remembers`, () => {
    const lookup = (rows: { id: string; tunnelId: string; ownerId: string }[], tombstones: string[]) =>
        unstubbed<PrismaClient>(`prisma`, {
            sandbox: delegate(`sandbox`, { findMany: async () => rows }),
            sandboxTombstone: delegate(`sandboxTombstone`, { findMany: async () => tombstones.map((tunnelId) => ({ tunnelId })) }),
        });

    it(`answers yours, other, deleted and unknown in the order asked, dropping what is no id`, async () => {
        const prisma = lookup(
            [
                { id: `mine`, tunnelId: `aaaaaaaaaaaa`, ownerId: `u1` },
                { id: `theirs`, tunnelId: `bbbbbbbbbbbb`, ownerId: `u2` },
            ],
            [`cccccccccccc`],
        );
        expect(await standingsOf(prisma, `u1`, [`dddddddddddd`, `aaaaaaaaaaaa`, `not-an-id`, `bbbbbbbbbbbb`, `cccccccccccc`, `aaaaaaaaaaaa`])).toEqual([
            { sandboxId: `dddddddddddd`, standing: `unknown` },
            { sandboxId: `aaaaaaaaaaaa`, standing: `yours`, id: `mine` },
            { sandboxId: `bbbbbbbbbbbb`, standing: `other` },
            { sandboxId: `cccccccccccc`, standing: `deleted` },
        ]);
    });
});

describe(`the adoption ticket`, () => {
    it(`verifies for its own key, inside its window`, () => {
        expect(verifyAdoptionTicket(PUBLIC_KEY, ticketFor(TUNNEL_ID), NOW + 1000)).toEqual({
            sandboxId: TUNNEL_ID,
            userId: `u1`,
            expiresAt: NOW + ADOPTION_TICKET_TTL_MS,
        });
    });

    it(`stops verifying at its expiry`, () => {
        expect(verifyAdoptionTicket(PUBLIC_KEY, ticketFor(TUNNEL_ID), NOW + ADOPTION_TICKET_TTL_MS)).toBeUndefined();
    });

    it(`refuses another key's signature, another prefix and a tampered claim`, () => {
        const ticket = ticketFor(TUNNEL_ID);
        const [, payload, signature] = ticket.split(`.`);
        const forged = Buffer.from(JSON.stringify({ sub: TUNNEL_ID, uid: `u2`, iat: 0, exp: Math.floor(NOW / 1000) + 600 })).toString(`base64url`);
        // A key nobody signs with here: another platform's, as far as this one can tell.
        const otherKey = publicKeyPemOf(generateKeyPairSync(`ed25519`).privateKey.export({ type: `pkcs8`, format: `pem` }).toString());
        expect(verifyAdoptionTicket(otherKey, ticket, NOW)).toBeUndefined();
        expect(verifyAdoptionTicket(PUBLIC_KEY, `ot1.${payload}.${signature}`, NOW)).toBeUndefined();
        expect(verifyAdoptionTicket(PUBLIC_KEY, `at1.${forged}.${signature}`, NOW)).toBeUndefined();
        expect(verifyAdoptionTicket(PUBLIC_KEY, `at1.garbage`, NOW)).toBeUndefined();
    });

    it(`names a 12-hex sandbox or is not minted`, () => {
        expect(() => ticketFor(`not-an-id`)).toThrow(`an adoption ticket names a 12-hex sandbox id, got "not-an-id"`);
    });
});

describe(`adopting a sandbox the registry has no row for`, () => {
    it(`makes the row again under the token, the derived address and the asking account`, async () => {
        const { prisma, create } = registry();
        expect(await adoptSandbox(prisma, config, request(), NOW)).toEqual({ kind: `adopted`, sandboxId: `adopted` });
        expect(create.mock.calls).toEqual([
            [
                {
                    data: {
                        name: `intentic`,
                        ownerId: `u1`,
                        token: TOKEN,
                        tokenDigest: DIGEST,
                        tunnelId: TUNNEL_ID,
                        daemonUrl: DAEMON_URL,
                        daemonVersion: `1.2.3`,
                        lastSeenAt: new Date(NOW),
                        firstAnnouncedAt: new Date(NOW),
                    },
                    select: { id: true },
                },
            ],
        ]);
    });

    it(`keeps a remembered logo and falls back to a plain name`, async () => {
        const { prisma, create } = registry();
        await adoptSandbox(prisma, config, request({ name: `   `, image: `data:image/webp;base64,AAAA` }), NOW);
        expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { name: `Recovered sandbox`, image: `data:image/webp;base64,AAAA` } });
    });

    it(`answers with the row already there when it is this owner's, and makes nothing`, async () => {
        const { prisma, create } = registry({ held: { id: `s1`, ownerId: `u1`, tokenDigest: DIGEST } });
        expect(await adoptSandbox(prisma, config, request(), NOW)).toEqual({ kind: `already`, sandboxId: `s1` });
        expect(create).not.toHaveBeenCalled();
    });

    it(`refuses an id another account holds`, async () => {
        const { prisma } = registry({ held: { id: `s9`, ownerId: `u2`, tokenDigest: DIGEST } });
        expect(await adoptSandbox(prisma, config, request(), NOW)).toEqual({ kind: `refused`, status: 409, message: `this sandbox is registered to another account` });
    });

    it(`refuses a deleted sandbox: deleting is how an owner says they are finished with it`, async () => {
        const { prisma, create } = registry({ tombstoned: true });
        expect(await adoptSandbox(prisma, config, request(), NOW)).toEqual({
            kind: `refused`,
            status: 410,
            message: `this sandbox was deleted from intentic: restore it from the trash, or set up a new one`,
        });
        expect(create).not.toHaveBeenCalled();
    });

    it(`refuses a ticket for another sandbox, an expired one and one this key did not sign`, async () => {
        const { prisma } = registry();
        expect(await adoptSandbox(prisma, config, request({ ticket: ticketFor(`0123456789ab`) }), NOW)).toEqual({
            kind: `refused`,
            status: 403,
            message: `this adoption ticket is for another sandbox`,
        });
        expect(await adoptSandbox(prisma, config, request({ ticket: ticketFor(TUNNEL_ID, `u1`, NOW - ADOPTION_TICKET_TTL_MS) }), NOW)).toEqual({
            kind: `refused`,
            status: 401,
            message: `the adoption ticket is invalid or expired: press Reconnect again`,
        });
    });

    it(`refuses a grant this platform did not sign for this token`, async () => {
        const { prisma } = registry();
        expect(await adoptSandbox(prisma, config, request({ grant: mintReachabilityGrant(INGRESS_TEST_PRIVATE_KEY, `0123456789ab`, NOW) }), NOW)).toEqual({
            kind: `refused`,
            status: 403,
            message: `this sandbox's grant was not signed by this platform`,
        });
    });

    it(`refuses an address the token does not derive`, async () => {
        const { prisma } = registry();
        expect(await adoptSandbox(prisma, config, request({ daemonUrl: `https://elsewhere.example.com` }), NOW)).toEqual({
            kind: `refused`,
            status: 400,
            message: `this sandbox answers at sandbox-${TUNNEL_ID}.${testIngressConfig.zone}, not elsewhere.example.com`,
        });
    });

    it(`refuses a daemon whose owner is not the asking account, and one with no owner`, async () => {
        const { prisma } = registry();
        const notOwner: AdoptionVerdict = { kind: `refused`, status: 403, message: `this sandbox's owner is not the account that asked to reconnect it` };
        expect(await adoptSandbox(prisma, config, request({ owner: `someone@example.com` }), NOW)).toEqual(notOwner);
        expect(await adoptSandbox(prisma, config, request({ owner: undefined }), NOW)).toEqual(notOwner);
    });

    it(`refuses on a platform that hands out no addresses, since it has no grant to check`, async () => {
        const { prisma } = registry();
        const addressless = { ...config, ingress: { ...config.ingress, signingKey: `` } };
        expect(await adoptSandbox(prisma, addressless, request(), NOW)).toEqual({
            kind: `refused`,
            status: 404,
            message: `this platform hands out no addresses, so it cannot vouch for a sandbox: connect it by its address instead`,
        });
    });

    it(`answers a lost race with the winner's row when the winner is this owner`, async () => {
        const findUnique = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: `won`, ownerId: `u1`, tokenDigest: DIGEST });
        const prisma = unstubbed<PrismaClient>(`prisma`, {
            user: delegate(`user`, { findUnique: async () => ({ email: `owner@example.com` }) }),
            sandbox: delegate(`sandbox`, {
                findUnique,
                create: async () => {
                    throw new Prisma.PrismaClientKnownRequestError(`unique`, { code: `P2002`, clientVersion: `7` });
                },
            }),
            sandboxTombstone: delegate(`sandboxTombstone`, { findUnique: async () => null }),
        });
        expect(await adoptSandbox(prisma, config, request(), NOW)).toEqual({ kind: `already`, sandboxId: `won` });
    });
});
