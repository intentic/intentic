import { DeviceReportSchema, type SyncEnrollmentAnswer, type SyncEnrollmentRequest, SyncEnrollmentRequestSchema } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import { revokeCardlessHost } from "./host-peer.js";
import { sshdHostKey } from "./desktop-sync-ssh.js";
import type { AppEnv } from "../app-env.js";
import {
    deviceReports,
    enrollSyncKey,
    isFileSyncEnrolled,
    isKeyEnrolled,
    isValidAuthorizedKey,
    recordDeviceReport,
    revokeEnrollmentByMachine,
    revokeEnrollmentByToken,
    type SyncMode,
} from "./desktop-sync.js";

// Desktop sync's enrollment surface: a browser-minted pairing token is redeemed at /system/authorized-key to land an SSH
// key, once per machine key. The pairing carries the mode: owner gets sync, a member only ever mirror. Transport is
// desktop-sync-ssh.ts.

// How long a redeemed pairing stays good for the key that redeemed it: the pairing's own lifetime (enrollment.ts).
const REENROLL_WINDOW_MS = 10 * 60 * 1000;

// A MACHINE'S SETUP GOES ON PAST ITS ENROLLMENT (linking the folder, starting the sync engine, proving the SSH path), and
// a failure there is retried by enrolling again with the same pairing. Spent on the first redemption, that retry could
// only fail at enrollment: the desktop app's Try again did, every time. So a redeemed pairing stays good for the key
// that redeemed it, for the pairing's lifetime, and for no other key. In memory and by digest, as pairings are.
const reenrollments = () => {
    const redeemed = new Map<string, { readonly mode: SyncMode; readonly key: string; readonly until: number }>();
    return {
        // The mode this pairing granted, when this same key redeemed it and its window is still open.
        modeFor: (pair: string, key: string): SyncMode | undefined => {
            const held = redeemed.get(sha256Hex(pair));
            return held !== undefined && held.until >= Date.now() && held.key === key ? held.mode : undefined;
        },
        remember: (pair: string, key: string, mode: SyncMode): void => {
            const now = Date.now();
            for (const [digest, held] of redeemed) {
                if (held.until < now) {
                    redeemed.delete(digest);
                }
            }
            redeemed.set(sha256Hex(pair), { mode, key, until: now + REENROLL_WINDOW_MS });
        },
        // A revoke ends every window: a machine cut off minutes after enrolling must not walk back in with the pairing it
        // redeemed. Every one rather than the revoked machine's own, since a window knows its key and not its machine;
        // a setup still retrying elsewhere asks for a new pairing, which is the rare cost.
        forget: (): void => {
            redeemed.clear();
        },
    };
};

// Whole Services, not a slice of it: revoking a machine reaches past desktop sync into the device door it may also
// hold, and that teardown runs the capability handler.
export const createSyncRoutes = (services: Services, redeemed = reenrollments()) => ({
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
        const live = pair === undefined ? undefined : services.syncPairings.peek(pair);
        const raw: unknown = await c.req.json().catch(() => undefined);
        // Which computer and install is enrolling, when its agent is new enough to say; an identity that does not parse
        // is left unsaid rather than refusing the key it came with.
        const body: SyncEnrollmentRequest | undefined =
            SyncEnrollmentRequestSchema.safeParse(raw).data ?? SyncEnrollmentRequestSchema.pick({ key: true }).safeParse(raw).data;
        // Already redeemed, by this same key: the machine retrying a setup that failed after it enrolled.
        const again = live === undefined && pair !== undefined && body !== undefined ? redeemed.modeFor(pair, body.key.trim()) : undefined;
        const paired = live ?? again;
        const viaPair = paired !== undefined;
        if (!viaPair) {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
        }
        if (body === undefined || !isValidAuthorizedKey(body.key)) {
            return c.json({ error: "invalid key" }, 400);
        }
        const { key, machineId, environment } = body;
        // Mode comes from the pairing, never the agent: a member's pairing can only enroll mirror.
        const mode: SyncMode = paired ?? "sync";
        // Sync enroll is single-holder: a conflict returns 423 before consuming the token, so a retry can reuse it.
        const takeover = c.req.header("x-intentic-sync-takeover") === "1";
        const result = await enrollSyncKey({ historyRoot: services.config.historyRoot, key, mode, takeover, machineId, environment });
        if ("locked" in result) {
            return c.json({ error: "sync already active", machine: result.locked }, 423);
        }
        // Burned only on success, so a transient failure leaves the token usable for a retry; and still good for this key.
        if (pair !== undefined && live !== undefined) {
            await services.syncPairings.consume(pair);
            redeemed.remember(pair, key.trim(), mode);
        }
        // No address returned: the agent reaches sshd via this daemon's own sync-ssh route, at the URL it already uses.
        // The key that sshd presents rides along, so the agent pins it instead of trusting the first one it is shown;
        // an unreadable one costs the pin, never the enrollment that already happened.
        const answer: SyncEnrollmentAnswer = { ok: true, syncToken: result.syncToken, mode };
        try {
            const hostKey = await sshdHostKey(services.config.historyRoot);
            if (hostKey !== undefined) {
                answer.hostKey = hostKey;
            }
        } catch (err) {
            services.logger.warn({ err }, "sync enrollment: the sshd host key could not be read, the machine will trust it on first use");
        }
        return c.json(answer);
    },
    /** GET /system/sync */
    state: async (c: Context<AppEnv>): Promise<Response> => {
        // Any collaborator may read state; the bearer middleware already blocked a non-member.
        // `available` is always true, since every sandbox serving this can also carry sync. Per-device holder state
        // lives on /system/devices; `machines` is each device's self-report and may be empty.
        return c.json({
            enrolled: await isKeyEnrolled(services.config.historyRoot),
            // Separate from `enrolled`: a ports-only mirror is an enrollment that holds none of this sandbox's files.
            syncing: await isFileSyncEnrolled(services.config.historyRoot),
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
    revokeOwn: async (c: Context<AppEnv>): Promise<Response> => {
        if (!(await revokeEnrollmentByToken(services.config.historyRoot, c.req.header("x-intentic-sync") ?? ""))) {
            return c.json({ error: "unknown enrollment" }, 404);
        }
        redeemed.forget();
        return c.json({ ok: true });
    },
    // Owner's way out, one device at a time, matching DELETE /system/hosts/:id: no fleet-wide revoke, so cutting off
    // one laptop can't drop anyone else's mirror. Owner-only; not exempt from the bearer middleware.
    revokeMachine: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const machine = c.req.param("machine") ?? "";
        // A machine can hold two doors and this screen shows one: the ssh key it syncs with, and a device enrollment
        // whose card is gone, which no screen lists. Both end here, or "revoked" would leave a live credential behind.
        const door = await revokeCardlessHost(services, machine);
        const key = await revokeEnrollmentByMachine(services.config.historyRoot, machine);
        if (!key && !door) {
            return c.json({ error: "no device is enrolled under that name" }, 404);
        }
        redeemed.forget();
        return c.json({ ok: true });
    },
});
