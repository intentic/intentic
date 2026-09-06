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

/* Desktop sync's enrollment surface (platform/sync.ts). The browser mints a short-lived pairing token; the
 * desktop agent redeems it once at /system/authorized-key to land its SSH key, so the agent needs no OAuth,
 * and trust roots in the Google identity that minted the token. The pairing carries the MODE it may enroll:
 * the owner gets full file "sync" (default, or "mirror" on request), a member (collaborator) can only get
 * port "mirror", so live previews are everyone's while the single-holder file-sync lock stays
 * owner-territory. The transport itself is /system/sync/ssh (platform/sync-ssh.ts). */

export type SyncRoutesDeps = Pick<Services, "auth" | "config" | "syncPairings">;

export const createSyncRoutes = (services: SyncRoutesDeps) => ({
    // POST /system/sync/pair. Runs through the bearer middleware (not exempt), so an unauthenticated caller is
    // already 401'd here; a caller the operating gate refuses is not refused but narrowed to "mirror".
    pair: async (c: Context<AppEnv>): Promise<Response> => {
        const requested = c.req.query("mode") === "mirror" ? "mirror" : "sync";
        const mode: SyncMode = (await ownerDenied(services, c)) === undefined ? requested : "mirror";
        return c.json({ ...services.syncPairings.mint(mode), mode });
    },
    // POST /system/authorized-key. Exempt from the bearer middleware (app.ts): the POST is redeemed with a
    // one-time pairing token the handler checks itself.
    enrollKey: async (c: Context<AppEnv>): Promise<Response> => {
        // Authorized either by a valid pairing token (the agent's path) or the owner's Google token (fallback).
        const pair = c.req.header("x-intentic-pair") ?? undefined;
        // Read once, here: the mode this pairing grants is the one that authorized the request, and peeking
        // for it again after the awaits below would let a token that expired mid-request enroll under a
        // different mode than the one it was let in on.
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
        // The mode comes from the pairing (minted per the requester's role), never from the agent, so a member's
        // pairing can only ever enroll "mirror". The owner-Google fallback path defaults to full "sync".
        const mode: SyncMode = paired ?? "sync";
        // A "sync" enroll is single-holder: if a different machine holds it and this isn't a takeover, 423 Locked
        // (before consuming the token, so a retry with --takeover reuses the same pairing). Mirror enrolls never lock.
        const takeover = c.req.header("x-intentic-sync-takeover") === "1";
        const result = await enrollSyncKey({ historyRoot: services.config.historyRoot, key, mode, takeover });
        if ("locked" in result) {
            return c.json({ error: "sync already active", machine: result.locked }, 423);
        }
        // Burn the pairing token only on success, so a transient failure leaves it usable for a retry.
        if (pair !== undefined) {
            await services.syncPairings.consume(pair);
        }
        /* No address travels back any more, because there is no longer one to choose: the agent reaches sshd
         * through THIS daemon (platform/sync-ssh.ts), at the public URL it is already talking to. That is what
         * makes every sandbox sync the same way, the enroll used to answer 409 whenever the sandbox's
         * reachability could not also carry TCP, which is every sandbox on the platform's own hub. */
        return c.json({ ok: true, syncToken: result.syncToken, mode });
    },
    /** GET /system/sync */
    state: async (c: Context<AppEnv>): Promise<Response> => {
        // Any collaborator (owner or member) may read enrollment state, the bearer middleware already blocked a
        // non-member, so a member's Desktop-sync card can render and mint its mirror-only pairing.
        /* Always 200, and `available` is now always true: sync rides this daemon's own HTTPS surface, so every
         * sandbox that can serve this response can also carry the transport (platform/sync-ssh.ts). It stays in
         * the body because the pairing card branches on it, and because a sandbox that CANNOT do sync is a state
         * worth being able to express again rather than one to delete the vocabulary for.
         *
         * WHICH MACHINE HOLDS WHAT IS NOT HERE ANY MORE. This route used to flatten the enrollment list into a
         * `syncingFrom` holder and a `mirroredBy` list of names, for a card that presented a sandbox as having
         * one desktop sync. Every one of those facts is per DEVICE, so it rides on the device's own row
         * (/system/devices → DeviceSync), where the reader can also act on it. What is left here is what is
         * genuinely about this sandbox.
         *
         * `machines` is what each enrolled device says about ITSELF (folders, ports, watcher). It stays because
         * it is the cheap ambient read the rail's badge lives on: already in this daemon's memory, so a chip
         * never costs a fan-out to somebody's laptop. Empty until a machine's watcher posts one, so every reader
         * must render without it. */
        return c.json({
            enrolled: await isKeyEnrolled(services.config.historyRoot),
            available: true,
            machines: (await deviceReports(services.config.historyRoot)).map((entry) => entry.report),
        });
    },
    /* POST /system/sync/report. The machine's own report, filed on the same credential its ports poll uses
     * (grants.ts scopes the sync token to exactly this route and that read). The agent posts on its watch tick,
     * so the sandbox learns the folder, the ports and the watcher's liveness without ever asking for anything
     * new from the device. */
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
    /* DELETE /system/authorized-key. THE AGENT'S OWN WAY OUT: `intentic-machine sync uninstall` presents its
     * sync token and drops the one enrollment that token belongs to. Nobody else's, which is what lets a
     * collaborator's laptop walk away from a shared sandbox without disturbing the owner's file sync. Exempt
     * from the bearer middleware (app.ts): the agent self-revokes with its own sync token. */
    revokeOwn: async (c: Context<AppEnv>): Promise<Response> =>
        (await revokeEnrollmentByToken(services.config.historyRoot, c.req.header("x-intentic-sync") ?? ""))
            ? c.json({ ok: true })
            : c.json({ error: "unknown enrollment" }, 404),
    /* DELETE /system/authorized-key/:machine. THE OWNER'S WAY OUT, ONE DEVICE AT A TIME, and the shape is the
     * point: it is `DELETE /system/hosts/:id` for the sync door, which is what every other connection in this
     * product already looks like.
     *
     * What it replaces cleared the WHOLE store, because it sat under a card that treated desktop sync as one
     * property of the sandbox. So "I don't use that laptop any more" was spelled "cut off every device,
     * including the ones mirroring ports for people who are not me", and the alternative was walking to the
     * laptop. There is no fleet-wide kill switch behind this on purpose: revoking three devices is three
     * deliberate acts, and each of them is a row the reader is already looking at.
     *
     * Owner-only, like the hosts revoke beside it: a member may hold a mirror enrollment of their own (and drops
     * it from their own machine), but ending somebody else's is the owner's call. Not exempt from the bearer
     * middleware: it is an owner acting in a browser, and it goes through the middleware and then this owner
     * check like every other revoke. */
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
