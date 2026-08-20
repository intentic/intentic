import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import type { ApnsForwarder, ApnsVerdict } from "./apns.js";
import { pushRelayRoutes } from "./push-relay.routes.js";

/* The relay's guarantees, which are the only things about it worth testing: the plaintext secret exists once
 * (the register response) and its hash is what a send is judged by; refusals speak the daemon's dead-channel
 * codes so pruning works end to end; and Apple's verdicts translate to exactly the right daemon-facing
 * statuses — in particular a misconfigured relay must read as "down", never as "prune every iPhone". */

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };

const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

// Each test builds routes with its own forwarder; the config is a fresh object per context so the module's
// per-config forwarder cache can never leak one test's fake into another.
const forwarder = (verdict: ApnsVerdict): ApnsForwarder & { send: ReturnType<typeof vi.fn> } => ({
    enabled: true,
    send: vi.fn().mockResolvedValue(verdict),
});

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: { api: { url: `https://platform.example` }, apns: { keyP8: `key` } } as Config,
        user,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        headers: new Headers(),
        ...overrides,
    }) as OrpcContext;

const notification = { title: `Turn finished`, body: `done`, tag: `conv-1` };

describe(`register`, () => {
    it(`mints a fresh secret, stores only its hash, and answers with the grant the daemon will hold`, async () => {
        const upsert = vi.fn().mockImplementation(async (args: { create: { secretHash: string } }) => ({ id: `d1`, ...args.create }));
        const ctx = context({ prisma: fakePrisma({ pushDevice: { upsert } }) });

        const grant = await call(pushRelayRoutes(() => forwarder(`delivered`)).register, { platform: `ios`, token: `tok-1` }, { context: ctx });

        expect(grant.deviceId).toBe(`d1`);
        // The url is absolute and points at THIS platform — a self-hosted deployment's grants point home.
        expect(grant.url).toBe(`https://platform.example/rpc/push/send`);
        // The row holds a hash; the grant holds the secret; they must correspond and never coincide.
        const stored = upsert.mock.calls[0]?.[0];
        expect(stored.create.secretHash).not.toBe(grant.secret);
        expect(stored.create.secretHash).toMatch(/^[0-9a-f]{64}$/);
        // Upserting by (user, token) is what makes a reinstall replace its row — and rotate the secret.
        expect(stored.where).toEqual({ userId_token: { userId: `u1`, token: `tok-1` } });
    });

    it(`refuses without a session`, async () => {
        const routes = pushRelayRoutes(() => forwarder(`delivered`));
        await expect(call(routes.register, { platform: `ios`, token: `t` }, { context: context({ user: null }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`404s on a platform with no APNs key — a relay that cannot forward must say it does not exist`, async () => {
        const routes = pushRelayRoutes(() => ({ enabled: false, send: vi.fn() }));
        await expect(call(routes.register, { platform: `ios`, token: `t` }, { context: context() })).rejects.toMatchObject({
            code: `NOT_FOUND`,
        });
    });
});

describe(`unregister`, () => {
    it(`scopes the delete to the caller's own rows — someone else's deviceId deletes nothing and learns nothing`, async () => {
        const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
        const ctx = context({ prisma: fakePrisma({ pushDevice: { deleteMany } }) });

        await expect(call(pushRelayRoutes(() => forwarder(`delivered`)).unregister, { deviceId: `d9` }, { context: ctx })).resolves.toEqual({
            ok: true,
        });
        expect(deleteMany).toHaveBeenCalledWith({ where: { id: `d9`, userId: `u1` } });
    });
});

describe(`send`, () => {
    const row = (secretHash: string) => ({ id: `d1`, userId: `u1`, platform: `ios`, token: `tok-1`, secretHash });

    // A real grant's secret/hash pair, produced the same way register produces them.
    const minted = async (): Promise<{ secret: string; hash: string }> => {
        const { createHash } = await import(`node:crypto`);
        const secret = `s`.repeat(43);
        return { secret, hash: createHash(`sha256`).update(secret).digest(`hex`) };
    };

    it(`is sessionless and forwards to the row's token when the secret matches`, async () => {
        const { secret, hash } = await minted();
        const apns = forwarder(`delivered`);
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: vi.fn().mockResolvedValue(row(hash)) } }) });

        await expect(call(pushRelayRoutes(() => apns).send, { deviceId: `d1`, secret, notification }, { context: ctx })).resolves.toEqual({
            delivered: true,
        });
        expect(apns.send).toHaveBeenCalledWith(`tok-1`, notification);
    });

    it(`answers 404 for an unknown device — the daemon prunes and never retries`, async () => {
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: vi.fn().mockResolvedValue(null) } }) });
        await expect(
            call(pushRelayRoutes(() => forwarder(`delivered`)).send, { deviceId: `dx`, secret: `s`, notification }, { context: ctx }),
        ).rejects.toMatchObject({ code: `NOT_FOUND` });
    });

    it(`answers 403 for a rotated secret — the old daemon row is permanently dead`, async () => {
        const { hash } = await minted();
        const ctx = context({ user: null, prisma: fakePrisma({ pushDevice: { findUnique: vi.fn().mockResolvedValue(row(hash)) } }) });
        await expect(
            call(pushRelayRoutes(() => forwarder(`delivered`)).send, { deviceId: `d1`, secret: `wrong`, notification }, { context: ctx }),
        ).rejects.toMatchObject({ code: `FORBIDDEN` });
    });

    it(`deletes the row and answers 410 when Apple says the device is gone — both halves of the channel die together`, async () => {
        const { secret, hash } = await minted();
        const remove = vi.fn().mockResolvedValue({});
        const ctx = context({
            user: null,
            prisma: fakePrisma({ pushDevice: { findUnique: vi.fn().mockResolvedValue(row(hash)), delete: remove } }),
        });

        await expect(
            call(pushRelayRoutes(() => forwarder(`dead`)).send, { deviceId: `d1`, secret, notification }, { context: ctx }),
        ).rejects.toMatchObject({ status: 410 });
        expect(remove).toHaveBeenCalledWith({ where: { id: `d1` } });
    });

    it(`answers 502 on a transient — a misconfigured relay must never read as "prune every iPhone"`, async () => {
        const { secret, hash } = await minted();
        const remove = vi.fn();
        const ctx = context({
            user: null,
            prisma: fakePrisma({ pushDevice: { findUnique: vi.fn().mockResolvedValue(row(hash)), delete: remove } }),
        });

        await expect(
            call(pushRelayRoutes(() => forwarder(`transient`)).send, { deviceId: `d1`, secret, notification }, { context: ctx }),
        ).rejects.toMatchObject({ status: 502 });
        // The row survives: the device is fine, we are not.
        expect(remove).not.toHaveBeenCalled();
    });
});
