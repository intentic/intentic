import { DeviceReportSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import {
    deviceReports,
    enrollSyncKey,
    isKeyEnrolled,
    isValidAuthorizedKey,
    recordDeviceReport,
    revokeEnrollmentByMachine,
    revokeEnrollmentByToken,
    type SyncMode,
} from "./sync.js";

// Desktop sync's enrollment surface: a browser-minted pairing token is redeemed once at /system/authorized-key to land
// an SSH key. The pairing carries the mode: owner gets sync, a member only ever mirror. Transport is sync-ssh.ts.

export type SyncRoutesDeps = Pick<Services, "auth" | "config" | "syncPairings">;

export const createSyncRoutes = (services: SyncRoutesDeps) => ({
    // Runs through the bearer middleware, so an unauthenticated caller is already 401'd; a caller the operating gate
    // refuses is narrowed to mirror, not refused.
    pair: async (c: Context<AppEnv>): Promise<Response> => {
        const requested = c.req.query("mode") === "mirror" ? "mirror" : "sync";
        const mode: SyncMode = (await ownerDenied(services, c)) === undefined ? requested : "mirror";
        return c.json({ ...services.syncPairings.mint(mode), mode });
    },
    // Exempt from the bearer middleware: redeemed with a one-time pairing token the handler checks itself.
    enrollKey: async (c: Context<AppEnv>): Promise<Response> => {
        // Authorized by a valid pairing token (the agent's path) or the owner's Google token (fallback).
        const pair = c.req.header("x-intentic-pair") ?? undefined;
        // Read once, before the awaits below, so a token that expires mid-request can't enroll under a different mode.
        const paired = pair === undefined ? undefined : services.syncPairings.peek(pair);
        const viaPair = paired !== undefined;
        if (!viaPair) {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
        }
        const body = (await c.req.json().catch(() => undefined)) as { key?: unknown } | undefined;
        const key = typeof body?.key === "string" ? body.key : undefined;
        if (key === undefined || !isValidAuthorizedKey(key)) {
            return c.json({ error: "invalid key" }, 400);
        }
        // Mode comes from the pairing, never the agent: a member's pairing can only enroll mirror.
        const mode: SyncMode = paired ?? "sync";
        // Sync enroll is single-holder: a conflict returns 423 before consuming the token, so a retry can reuse it.
        const takeover = c.req.header("x-intentic-sync-takeover") === "1";
        const result = await enrollSyncKey({ historyRoot: services.config.historyRoot, key, mode, takeover });
        if ("locked" in result) {
            return c.json({ error: "sync already active", machine: result.locked }, 423);
        }
        // Burned only on success, so a transient failure leaves the token usable for a retry.
        if (pair !== undefined) {
            await services.syncPairings.consume(pair);
        }
        // No address returned: the agent reaches sshd via this daemon's own sync-ssh route, at the URL it already uses.
        return c.json({ ok: true, syncToken: result.syncToken, mode });
    },
    /** GET /system/sync */
    state: async (c: Context<AppEnv>): Promise<Response> => {
        // Any collaborator may read state; the bearer middleware already blocked a non-member.
        // `available` is always true, since every sandbox serving this can also carry sync. Per-device holder state
        // lives on /system/devices; `machines` is each device's self-report and may be empty.
        return c.json({
            enrolled: await isKeyEnrolled(services.config.historyRoot),
            available: true,
            machines: (await deviceReports(services.config.historyRoot)).map((entry) => entry.report),
        });
    },
    // Filed on the same credential the ports poll uses (grants.ts scopes it to this route and that read).
    report: async (c: Context<AppEnv>): Promise<Response> => {
        const sync = c.req.header("x-intentic-sync") ?? "";
        const parsed = DeviceReportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "malformed report" }, 400);
        }
        return (await recordDeviceReport(services.config.historyRoot, sync, parsed.data))
            ? c.json({ ok: true })
            : c.json({ error: "unknown enrollment" }, 403);
    },
    // Agent's own way out: drops only the enrollment its sync token belongs to; exempt from the bearer middleware.
    revokeOwn: async (c: Context<AppEnv>): Promise<Response> =>
        (await revokeEnrollmentByToken(services.config.historyRoot, c.req.header("x-intentic-sync") ?? ""))
            ? c.json({ ok: true })
            : c.json({ error: "unknown enrollment" }, 404),
    // Owner's way out, one device at a time, matching DELETE /system/hosts/:id: no fleet-wide revoke, so cutting off
    // one laptop can't drop anyone else's mirror. Owner-only; not exempt from the bearer middleware.
    revokeMachine: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return (await revokeEnrollmentByMachine(services.config.historyRoot, c.req.param("machine") ?? ""))
            ? c.json({ ok: true })
            : c.json({ error: "no device is enrolled under that name" }, 404);
    },
});
