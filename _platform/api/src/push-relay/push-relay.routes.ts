import { API_BASE_PATH, apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import type { PushApp, PushPlatform } from "@intentic/api-contract";
import { createApnsForwarder } from "./apns.js";
import { createFcmForwarder, type PushForwarder } from "./fcm.js";

const os = implement(apiContract).$context<OrpcContext>();

// The push relay: the platform's half of notifying a native install (apns.ts is Apple's half) and of reaching an
// Android app (fcm.ts is Firebase's half: the Intentic Device app is woken, the editor app is told what to fetch and
// show, and neither is sent a word of the notification).
// register: mints the send secret and stores only its hash; the plaintext exists nowhere else.
// unregister: the same app turning the toggle off, scoped to its own rows.
// send: sessionless; a daemon proves itself with the secret alone and tells the relay nothing about its sandbox. Only an
// editor app's row names one, the sandbox the app registered it for, so its notify can say which daemon to ask.

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const secretsMatch = (presented: string, storedHash: string): boolean => {
    const a = Buffer.from(hashSecret(presented));
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
};

// Per-process cached forwarders, one per config and platform, built on first use so tests can hand in fakes.
type Builders = Record<PushPlatform, (config: Config) => PushForwarder>;
const forwarders = new WeakMap<Config, Map<PushPlatform, PushForwarder>>();
const forwarderFor = (config: Config, builders: Builders, platform: PushPlatform): PushForwarder => {
    const held = forwarders.get(config) ?? new Map<PushPlatform, PushForwarder>();
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
const requireRelay = (forwarder: PushForwarder): void => {
    if (!forwarder.enabled) {
        throw new ORPCError("NOT_FOUND", { message: "this platform has no push relay" });
    }
};

// A row's platform as stored; one written before Android existed is iOS.
const platformOf = (stored: string): PushPlatform => (stored === "android" ? "android" : "ios");

// A row's app as stored; anything but the editor is the Device app, the lane every Android row was before the editor.
const appOf = (stored: string): PushApp => (stored === "editor" ? "editor" : "device");

// The app a registration is for: an iOS token is always the editor's iPhone app; an Android one is the Device app
// unless it says otherwise, which is how the Device app and the editor's phone-wake flow have always registered.
const appFor = (platform: PushPlatform, asked: PushApp | undefined): PushApp => (platform === "ios" ? "editor" : (asked ?? "device"));

export const pushRelayRoutes = (
    build: (config: Config) => PushForwarder = createApnsForwarder,
    buildAndroid: (config: Config) => PushForwarder = createFcmForwarder,
) => {
    const builders: Builders = { ios: build, android: buildAndroid };
    return {
        register: os.push.register.handler(async ({ input, context }) => {
            const user = requireUser(context);
            requireRelay(forwarderFor(context.config, builders, input.platform));
            // 32 random bytes is the capability; base64url so it rides JSON and logs greppably-opaque.
            const secret = randomBytes(32).toString("base64url");
            const app = appFor(input.platform, input.app);
            const sandbox = input.sandbox ?? "";
            // Upsert by (user, token, sandbox): a reinstalled app replaces its row rather than firing twice per
            // notification, and an editor app registering for one sandbox rotates that sandbox's secret, not the others'.
            const row = await context.prisma.pushDevice.upsert({
                where: { userId_token_sandbox: { userId: user.id, token: input.token, sandbox } },
                create: { userId: user.id, platform: input.platform, app, sandbox, token: input.token, secretHash: hashSecret(secret) },
                update: { secretHash: hashSecret(secret), app },
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
            const outcome = await forwarder.send(row.token, input.notification, { app: appOf(row.app), sandbox: row.sandbox });
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
