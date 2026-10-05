import { API_BASE_PATH, apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import type { PushPlatform } from "@intentic/api-contract";
import { createApnsForwarder, type ApnsForwarder } from "./apns.js";
import { createFcmForwarder } from "./fcm.js";

const os = implement(apiContract).$context<OrpcContext>();

// The push relay: the platform's half of notifying a native install (apns.ts is Apple's half) and of waking a phone's
// Intentic Device app (fcm.ts is Firebase's half; an Android row is a wake channel, never a notification).
// register: mints the send secret and stores only its hash; the plaintext exists nowhere else.
// unregister: the same app turning the toggle off, scoped to its own rows.
// send: sessionless; a daemon proves itself with the secret alone, learning nothing about the sandbox.

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const secretsMatch = (presented: string, storedHash: string): boolean => {
    const a = Buffer.from(hashSecret(presented));
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
};

// Per-process cached forwarders, one per config and platform, built on first use so tests can hand in fakes.
type Builders = Record<PushPlatform, (config: Config) => ApnsForwarder>;
const forwarders = new WeakMap<Config, Map<PushPlatform, ApnsForwarder>>();
const forwarderFor = (config: Config, builders: Builders, platform: PushPlatform): ApnsForwarder => {
    const held = forwarders.get(config) ?? new Map<PushPlatform, ApnsForwarder>();
    forwarders.set(config, held);
    const existing = held.get(platform);
    if (existing !== undefined) {
        return existing;
    }
    const built = builders[platform](config);
    held.set(platform, built);
    return built;
};

// 404s with no credential configured for that platform, like the platform's other credential-switched lanes.
const requireRelay = (forwarder: ApnsForwarder): void => {
    if (!forwarder.enabled) {
        throw new ORPCError("NOT_FOUND", { message: "this platform has no push relay" });
    }
};

// A row's platform as stored; one written before Android existed is iOS.
const platformOf = (stored: string): PushPlatform => (stored === "android" ? "android" : "ios");

export const pushRelayRoutes = (
    build: (config: Config) => ApnsForwarder = createApnsForwarder,
    buildAndroid: (config: Config) => ApnsForwarder = createFcmForwarder,
) => {
    const builders: Builders = { ios: build, android: buildAndroid };
    return {
        register: os.push.register.handler(async ({ input, context }) => {
            const user = requireUser(context);
            requireRelay(forwarderFor(context.config, builders, input.platform));
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
            const row = await context.prisma.pushDevice.findUnique({ where: { id: input.deviceId } });
            if (row === null) {
                throw new ORPCError("NOT_FOUND", { message: "unknown device" });
            }
            const forwarder = forwarderFor(context.config, builders, platformOf(row.platform));
            requireRelay(forwarder);
            if (!secretsMatch(input.secret, row.secretHash)) {
                throw new ORPCError("FORBIDDEN", { message: "this send capability has been rotated" });
            }
            const outcome = await forwarder.send(row.token, input.notification);
            if (outcome.verdict === "dead") {
                // Apple or Firebase says this device can never be reached again; drop our half too, so no half-dead channel lingers.
                await context.prisma.pushDevice.delete({ where: { id: row.id } }).catch(() => undefined);
                throw new ORPCError("GONE", { status: 410, message: "the device is no longer reachable" });
            }
            if (outcome.verdict === "transient") {
                // Our problem or a passing one, never the device's; the daemon keeps the channel, and only this log says which.
                context.logger.warn(
                    { deviceId: row.id, platform: row.platform, reason: outcome.reason },
                    "push relay: the push service did not take the send",
                );
                throw new ORPCError("BAD_GATEWAY", { status: 502, message: "the push service refused the send" });
            }
            return { delivered: true };
        }),
    };
};
