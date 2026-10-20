import { call, ORPCError } from "@orpc/server";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import type { ApnsForwarder, ApnsOutcome } from "./apns.js";
import { pushRelayRoutes } from "./push-relay.routes.js";

// The plaintext secret exists once (the register response); refusals speak the daemon's dead-channel codes, and a
// misconfigured relay reads as down, never as prune every iPhone.

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };

const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof jest.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

// Each test builds its own forwarder; a fresh config per context keeps the module's per-config cache from leaking.
const forwarder = (verdict: ApnsOutcome[`verdict`], reason = `ExpiredProviderToken`): ApnsForwarder & { send: ReturnType<typeof jest.fn> } => ({
    enabled: true,
    send: jest.fn().mockResolvedValue((verdict === `transient` ? { verdict, reason } : { verdict }) satisfies ApnsOutcome),
});

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: { api: { url: `https://platform.example` }, apns: { keyP8: `key` } } as Config,
        user,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        headers: new Headers(),
        ...overrides,
    }) as OrpcContext;

const notification = { title: `Turn finished`, body: `done`, tag: `conv-1` };

describe(`register`, () => {
    it(`mints a fresh secret, stores only its hash, and answers with the grant the daemon will hold`, async () => {
        const upsert = jest.fn().mockImplementation(async (args: { create: { secretHash: string } }) => ({ id: `d1`, ...args.create }));
        const ctx = context({ prisma: fakePrisma({ pushDevice: { upsert } }) });

        const grant = await call(pushRelayRoutes(() => forwarder(`delivered`)).register, { platform: `ios`, token: `tok-1` }, { context: ctx });

        expect(grant.deviceId).toBe(`d1`);
        // Absolute and points at this platform: a self-hosted deployment's grants point home.
        expect(grant.url).toBe(`https://platform.example/rpc/push/send`);
        // The row holds a hash, the grant holds the secret; they must correspond and never coincide.
        const stored = upsert.mock.calls[0]?.[0];
        expect(stored.create.secretHash).not.toBe(grant.secret);
        expect(stored.create.secretHash).toMatch(/^[0-9a-f]{64}$/);
        // Upserting by (user, token, sandbox) is what makes a reinstall replace its row, and rotate the secret; an iOS
        // registration names no sandbox, so its token keeps the one row it always had.
        expect(stored.where).toEqual({ userId_token_sandbox: { userId: `u1`, token: `tok-1`, sandbox: `` } });
        // An iPhone's only app is the editor.
        expect(stored.create).toMatchObject({ platform: `ios`, app: `editor`, sandbox: `` });
    });

    it(`refuses without a session`, async () => {
        const routes = pushRelayRoutes(() => forwarder(`delivered`));
        await expect(call(routes.register, { platform: `ios`, token: `t` }, { context: context({ user: null }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`404s on a platform with no APNs key: a relay that cannot forward must say it does not exist`, async () => {
        const routes = pushRelayRoutes(() => ({ enabled: false, send: jest.fn() }));
        await expect(call(routes.register, { platform: `ios`, token: `t` }, { context: context() })).rejects.toMatchObject({
            code: `NOT_FOUND`,
        });
    });
});

describe(`unregister`, () => {
    it(`scopes the delete to the caller's own rows, someone else's deviceId deletes nothing and learns nothing`, async () => {
        const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
        const ctx = context({ prisma: fakePrisma({ pushDevice: { deleteMany } }) });

        await expect(call(pushRelayRoutes(() => forwarder(`delivered`)).unregister, { deviceId: `d9` }, { context: ctx })).resolves.toEqual({
            ok: true,
        });
        expect(deleteMany).toHaveBeenCalledWith({ where: { id: `d9`, userId: `u1` } });
    });
});

describe(`send`, () => {
    const row = (secretHash: string) => ({ id: `d1`, userId: `u1`, platform: `ios`, app: `editor`, sandbox: ``, token: `tok-1`, secretHash });

    // A real grant's secret/hash pair, produced the same way register produces them.
    const minted = async (): Promise<{ secret: string; hash: string }> => {
        const { createHash } = await import(`node:crypto`);
        const secret = `s`.repeat(43);
        return { secret, hash: createHash(`sha256`).update(secret).digest(`hex`) };
    };

    it(`is sessionless and forwards to the row's token when the secret matches`, async () => {
        const { secret, hash } = await minted();
        const apns = forwarder(`delivered`);
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row(hash)) } }) });

        await expect(call(pushRelayRoutes(() => apns).send, { deviceId: `d1`, secret, notification }, { context: ctx })).resolves.toEqual({
            delivered: true,
        });
        expect(apns.send).toHaveBeenCalledWith(`tok-1`, notification, { app: `editor`, sandbox: `` });
    });

    // A withdrawn ask's replacement arrives silent; the relay must hand that on, or every iPhone buzzes for news that
    // needs nothing of its owner.
    it(`hands a silent replacement on to APNs as silent`, async () => {
        const { secret, hash } = await minted();
        const apns = forwarder(`delivered`);
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row(hash)) } }) });
        const replacement = { ...notification, tag: `awaiting-q1`, requireInteraction: false, silent: true };

        await call(pushRelayRoutes(() => apns).send, { deviceId: `d1`, secret, notification: replacement }, { context: ctx });
        expect(apns.send).toHaveBeenCalledWith(`tok-1`, replacement, { app: `editor`, sandbox: `` });
    });

    it(`answers 404 for an unknown device: the daemon prunes and never retries`, async () => {
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(null) } }) });
        await expect(
            call(pushRelayRoutes(() => forwarder(`delivered`)).send, { deviceId: `dx`, secret: `s`, notification }, { context: ctx }),
        ).rejects.toMatchObject({ code: `NOT_FOUND` });
    });

    it(`answers 403 for a rotated secret: the old daemon row is permanently dead`, async () => {
        const { hash } = await minted();
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row(hash)) } }) });
        await expect(
            call(pushRelayRoutes(() => forwarder(`delivered`)).send, { deviceId: `d1`, secret: `wrong`, notification }, { context: ctx }),
        ).rejects.toMatchObject({ code: `FORBIDDEN` });
    });

    it(`deletes the row and answers 410 when Apple says the device is gone: both halves of the channel die together`, async () => {
        const { secret, hash } = await minted();
        const remove = jest.fn().mockResolvedValue({});
        const ctx = context({
            user: null,
            prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row(hash)), delete: remove } }),
        });

        await expect(
            call(pushRelayRoutes(() => forwarder(`dead`)).send, { deviceId: `d1`, secret, notification }, { context: ctx }),
        ).rejects.toMatchObject({ status: 410 });
        expect(remove).toHaveBeenCalledWith({ where: { id: `d1` } });
    });

    it(`answers 502 on a transient: a misconfigured relay must never read as "prune every iPhone"`, async () => {
        const { secret, hash } = await minted();
        const remove = jest.fn();
        const ctx = context({
            user: null,
            prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row(hash)), delete: remove } }),
        });

        await expect(
            call(
                pushRelayRoutes(() => forwarder(`transient`, `APNs answered 403 InvalidProviderToken`)).send,
                { deviceId: `d1`, secret, notification },
                { context: ctx },
            ),
        ).rejects.toMatchObject({ status: 502 });
        // The row survives: the device is fine, we are not.
        expect(remove).not.toHaveBeenCalled();
        // And the platform says why, since the daemon only ever hears "refused".
        expect(ctx.logger.warn).toHaveBeenCalledWith(
            { deviceId: `d1`, platform: `ios`, reason: `APNs answered 403 InvalidProviderToken` },
            `push relay: the push service did not take the send`,
        );
    });
});

describe(`android channels`, () => {
    const minted = async (): Promise<{ secret: string; hash: string }> => {
        const { createHash } = await import(`node:crypto`);
        const secret = `w`.repeat(43);
        return { secret, hash: createHash(`sha256`).update(secret).digest(`hex`) };
    };

    it(`registers an android token through the FCM forwarder, and 404s when no service account is configured`, async () => {
        const upsert = jest.fn().mockImplementation(async (args: { create: { platform: string } }) => ({ id: `p1`, ...args.create }));
        const ctx = context({ prisma: fakePrisma({ pushDevice: { upsert } }) });
        const fcm = forwarder(`delivered`);
        await call(
            pushRelayRoutes(
                () => forwarder(`delivered`),
                () => fcm,
            ).register,
            { platform: `android`, token: `fcm-1` },
            { context: ctx },
        );
        // Naming no app is the Device app, which is how it and the editor's phone-wake flow have always registered.
        expect(upsert.mock.calls[0]?.[0].create).toMatchObject({ platform: `android`, app: `device`, sandbox: `` });
        await expect(
            call(
                pushRelayRoutes(
                    () => forwarder(`delivered`),
                    () => ({ enabled: false, send: jest.fn() }),
                ).register,
                { platform: `android`, token: `t` },
                { context: context() },
            ),
        ).rejects.toMatchObject({ code: `NOT_FOUND` });
    });

    it(`sends an android row through FCM and never through APNs`, async () => {
        const { secret, hash } = await minted();
        const apns = forwarder(`delivered`);
        const fcm = forwarder(`delivered`);
        const row = { id: `p1`, userId: `u1`, platform: `android`, app: `device`, sandbox: ``, token: `fcm-1`, secretHash: hash };
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row) } }) });
        await call(
            pushRelayRoutes(
                () => apns,
                () => fcm,
            ).send,
            { deviceId: `p1`, secret, notification },
            { context: ctx },
        );
        expect(fcm.send).toHaveBeenCalledWith(`fcm-1`, notification, { app: `device`, sandbox: `` });
        expect(apns.send).not.toHaveBeenCalled();
    });

    // One FCM token, one row per sandbox: the app knows which daemon to ask from the row, and registering again for one
    // sandbox rotates only that sandbox's secret, never the channel another sandbox holds.
    it(`files an editor app's registration under its sandbox, and rotates only that sandbox's row`, async () => {
        const upsert = jest.fn().mockImplementation(async (args: { create: { sandbox: string } }) => ({ id: `e-${args.create.sandbox}`, ...args.create }));
        const ctx = context({ prisma: fakePrisma({ pushDevice: { upsert } }) });
        const routes = pushRelayRoutes(
            () => forwarder(`delivered`),
            () => forwarder(`delivered`),
        );
        const first = await call(routes.register, { platform: `android`, app: `editor`, token: `fcm-e`, sandbox: `sbx-1` }, { context: ctx });
        const second = await call(routes.register, { platform: `android`, app: `editor`, token: `fcm-e`, sandbox: `sbx-2` }, { context: ctx });
        expect([first.deviceId, second.deviceId]).toEqual([`e-sbx-1`, `e-sbx-2`]);
        const [one, two] = upsert.mock.calls.map((args) => args[0]);
        expect(one.where).toEqual({ userId_token_sandbox: { userId: `u1`, token: `fcm-e`, sandbox: `sbx-1` } });
        expect(two.where).toEqual({ userId_token_sandbox: { userId: `u1`, token: `fcm-e`, sandbox: `sbx-2` } });
        expect(one.create).toMatchObject({ platform: `android`, app: `editor`, sandbox: `sbx-1` });
        expect(one.update).toEqual({ secretHash: one.create.secretHash, app: `editor` });
    });

    it(`hands an editor row's app and sandbox to FCM with the send`, async () => {
        const { secret, hash } = await minted();
        const fcm = forwarder(`delivered`);
        const row = { id: `e1`, userId: `u1`, platform: `android`, app: `editor`, sandbox: `sbx-1`, token: `fcm-e`, secretHash: hash };
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: jest.fn().mockResolvedValue(row) } }) });
        await call(
            pushRelayRoutes(
                () => forwarder(`delivered`),
                () => fcm,
            ).send,
            { deviceId: `e1`, secret, notification },
            { context: ctx },
        );
        expect(fcm.send).toHaveBeenCalledWith(`fcm-e`, notification, { app: `editor`, sandbox: `sbx-1` });
    });
});
