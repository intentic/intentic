import { API_BASE_PATH, apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { createApnsForwarder, type ApnsForwarder } from "./apns.js";

const os = implement(apiContract).$context<OrpcContext>();

// The push relay: the platform's half of notifying a native install (apns.ts is Apple's half).
// register: mints the send secret and stores only its hash; the plaintext exists nowhere else.
// unregister: the same app turning the toggle off, scoped to its own rows.
// send: sessionless; a daemon proves itself with the secret alone, learning nothing about the sandbox.

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const secretsMatch = (presented: string, storedHash: string): boolean => {
    const a = Buffer.from(hashSecret(presented));
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
};

// Per-process cached forwarder, one per config, built on first use so tests can hand it a fake.
const forwarders = new WeakMap<Config, ApnsForwarder>();
const forwarderFor = (config: Config, build: (config: Config) => ApnsForwarder): ApnsForwarder => {
    const existing = forwarders.get(config);
    if (existing !== undefined) {
        return existing;
    }
    const built = build(config);
    forwarders.set(config, built);
    return built;
};

// 404s with no APNs key configured, like the platform's other credential-switched lanes.
const requireRelay = (forwarder: ApnsForwarder): void => {
    if (!forwarder.enabled) {
        throw new ORPCError("NOT_FOUND", { message: "this platform has no push relay" });
    }
};

export const pushRelayRoutes = (build: (config: Config) => ApnsForwarder = createApnsForwarder) => ({
    register: os.push.register.handler(async ({ input, context }) => {
        const user = requireUser(context);
        requireRelay(forwarderFor(context.config, build));
        // 32 random bytes is the capability; base64url so it rides JSON and logs greppably-opaque.
        const secret = randomBytes(32).toString("base64url");
        // Upsert by (user, token): a reinstalled app replaces its row rather than firing twice per notification.
        const row = await context.prisma.pushDevice.upsert({
            where: { userId_token: { userId: user.id, token: input.token } },
            create: { userId: user.id, platform: input.platform, token: input.token, secretHash: hashSecret(secret) },
            update: { secretHash: hashSecret(secret) },
        });
        return {
            deviceId: row.id,
            secret,
            // Absolute on purpose: the daemon stores it verbatim, so a self-hosted platform's grant points home itself.
            url: `${context.config.api.url}${API_BASE_PATH}/push/send`,
        };
    }),

    unregister: os.push.unregister.handler(async ({ input, context }) => {
        const user = requireUser(context);
        // deleteMany because the ownership check is the where-clause: someone else's id deletes zero rows.
        await context.prisma.pushDevice.deleteMany({ where: { id: input.deviceId, userId: user.id } });
        return { ok: true } as const;
    }),

    // Sessionless: the caller is a daemon with no platform session, proven only by the per-device secret.
    send: os.push.send.handler(async ({ input, context }) => {
        const forwarder = forwarderFor(context.config, build);
        requireRelay(forwarder);
        const row = await context.prisma.pushDevice.findUnique({ where: { id: input.deviceId } });
        if (row === null) {
            throw new ORPCError("NOT_FOUND", { message: "unknown device" });
        }
        if (!secretsMatch(input.secret, row.secretHash)) {
            throw new ORPCError("FORBIDDEN", { message: "this send capability has been rotated" });
        }
        const verdict = await forwarder.send(row.token, input.notification);
        if (verdict === "dead") {
            // Apple says this device can never be reached again; drop our half too, so no half-dead channel lingers.
            await context.prisma.pushDevice.delete({ where: { id: row.id } }).catch(() => undefined);
            throw new ORPCError("GONE", { status: 410, message: "the device is no longer reachable" });
        }
        if (verdict === "transient") {
            // Our problem or a passing one, never the device's; the daemon logs this and keeps the channel.
            throw new ORPCError("BAD_GATEWAY", { status: 502, message: "the push service refused the send" });
        }
        return { delivered: true };
    }),
});
