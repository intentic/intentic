import { API_BASE_PATH, apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { createApnsForwarder, type ApnsForwarder } from "./apns.js";

const os = implement(apiContract).$context<OrpcContext>();

/* THE PUSH RELAY, the platform's half of notifying a native install (the contract file has the shape of the
 * whole handshake; apns.ts has the Apple half). What this file owns is the capability model:
 *
 *   register    signed-in web app inside the iOS shell. Mints the send secret, stores its HASH, answers with
 *               the grant the app stores on the DAEMON. The plaintext secret exists nowhere else, ever.
 *   unregister  the same app turning the toggle off, scoped to the caller's own rows.
 *   send        a daemon, sessionless, proving itself with the secret alone. The relay learns a device took a
 *               notification; it never learns which sandbox sent it.
 *
 * Refusals speak the daemon's dead-channel codes on purpose: 404 for a device row that does not exist, 403
 * for a secret that can never match again (re-registration rotates it). Both make the daemon prune, which is
 * exactly right, either way this channel will refuse every future send. APNs saying the device is gone
 * deletes the row AND answers 410, so the two halves of the channel die together. */

const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const secretsMatch = (presented: string, storedHash: string): boolean => {
    const a = Buffer.from(hashSecret(presented));
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
};

// The forwarder is per-process state (it caches a signed provider token); one per config object, built on
// first use so tests can hand the factory a fake without ever loading a key.
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

// Routes 404 when no APNs key is configured, matching the platform's other credential-switched lanes
// (hosted, pool, wallet): a relay that cannot forward must say it does not exist, not accept and drop.
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
        // Upsert by (user, token): a reinstalled app re-registering must replace its row, two rows for one
        // device would fire twice per notification, and every re-registration rotates the secret, which is
        // what retires any daemon rows still holding the old one.
        const row = await context.prisma.pushDevice.upsert({
            where: { userId_token: { userId: user.id, token: input.token } },
            create: { userId: user.id, platform: input.platform, token: input.token, secretHash: hashSecret(secret) },
            update: { secretHash: hashSecret(secret) },
        });
        return {
            deviceId: row.id,
            secret,
            // Absolute on purpose: the daemon stores it verbatim and never needs to know any platform's
            // layout, a self-hosted platform's grants point home automatically.
            url: `${context.config.api.url}${API_BASE_PATH}/push/send`,
        };
    }),

    unregister: os.push.unregister.handler(async ({ input, context }) => {
        const user = requireUser(context);
        // deleteMany because the ownership check IS the where-clause: someone else's deviceId deletes zero
        // rows and learns nothing.
        await context.prisma.pushDevice.deleteMany({ where: { id: input.deviceId, userId: user.id } });
        return { ok: true } as const;
    }),

    /* SESSIONLESS, and that is the whole point: the caller is a daemon on the owner's own hardware, which has
     * no platform session and never will. Possession of the per-device secret is its entire proof. */
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
            // Apple says this device can never be reached again. Drop our half and answer with a code the
            // daemon prunes on, so no half-dead channel lingers on either side.
            await context.prisma.pushDevice.delete({ where: { id: row.id } }).catch(() => undefined);
            throw new ORPCError("GONE", { status: 410, message: "the device is no longer reachable" });
        }
        if (verdict === "transient") {
            // Our problem or a passing one, never the device's. The daemon logs and keeps the channel.
            throw new ORPCError("BAD_GATEWAY", { status: 502, message: "the push service refused the send" });
        }
        return { delivered: true };
    }),
});
