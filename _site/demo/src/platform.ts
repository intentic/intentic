import type { HostedPlanState, SandboxSummary, User } from "@intentic/api-contract";
import { DEMO_DAEMON_ORIGIN, json } from "./transport";

/* THE PLATFORM, as a fetch handler, the small half. The app asks it three things before the workspace can
 * render, and they are exactly the three router gates:
 *
 *   GET /api/auth/get-session  → requireAuth: better-auth's session probe (not oRPC, its own client).
 *   GET /rpc/sandbox/list      → requireSetup: zero sandboxes would bounce the shell to /setup.
 *   GET /rpc/billing/plan      → the account badge, read lazily when the account panel opens.
 *
 * The sandbox row is what points the whole daemon half at the fixture: `daemonUrl` is the demo daemon's origin,
 * so sandboxClient, sandboxRpc and the terminal socket all address it without knowing anything has changed. */

export const DEMO_USER: User = { id: `demo-user`, email: `ada@acme.dev`, name: `Ada Lovelace`, image: null };

export const DEMO_SANDBOX: SandboxSummary = {
    id: `demo`,
    name: `acme-shop`,
    image: null,
    daemonUrl: DEMO_DAEMON_ORIGIN,
    lastSeenAt: new Date().toISOString(),
    setupCodeClaimedAt: null,
    // Null for the same reason `setupCodeClaimedAt` is: the demo's sandbox is already up, so no wizard run
    // ever reported on it.
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    token: `demo-connect-token`,
    role: `owner`,
    providedAddress: false,
    // No certified loopback shortcut: the demo's daemon is the fixture at `daemonUrl`, and there is no real
    // container publishing a port, no zone, and nothing for a CA to have signed. Null is what a platform with
    // the loopback-certificate path switched off reports, so the shell takes the same branch a visitor's
    // browser would and never reaches for 127.0.0.1.
    localHostname: null,
    // The demo's sandbox is a local one, not a machine the platform hosts.
    hosted: null,
};

// A platform that sells the hosted plan, to an account that holds it: the state in which Settings shows the
// Billing tab at all, which is the only reason the demo answers this. The hosted half is what the page lists
// under the plan: one slot, one machine in it, awake hours with no ceiling beside them.
const DEMO_HOSTED_PLAN: HostedPlanState = {
    enabled: true,
    onPlan: true,
    status: `active`,
    renewsAt: `2026-10-01T00:00:00.000Z`,
    priceUsd: 20,
    hosted: {
        slots: 1,
        machines: [{ sandboxId: DEMO_SANDBOX.id, name: DEMO_SANDBOX.name, region: `arn`, wokeAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }],
        usage: { month: new Date().toISOString().slice(0, 7), usedMinutes: 12_720, allowanceMinutes: null, resetsAt: `2026-10-01T00:00:00.000Z` },
        shape: { cpus: 4, memoryMb: 4096, volumeGb: 10 },
    },
};

const SESSION = {
    session: { id: `demo-session`, userId: DEMO_USER.id, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString() },
    user: DEMO_USER,
};

export const platform = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;

    if (path.startsWith(`/api/auth/`)) {
        // get-session is the only one the demo ever needs; sign-out and the rest are inert but must not 404
        // (better-auth surfaces a failed call as a thrown error, which the router guard would read as
        // signed-out and bounce to /login).
        return json(path.endsWith(`/get-session`) ? SESSION : { ok: true });
    }

    switch (path) {
        case `/rpc/sandbox/list`:
            return json({ sandboxes: [DEMO_SANDBOX] });
        case `/rpc/billing/plan`:
            return json({ plan: `pro`, entitlements: { sandboxes: 5, members: 10 } });
        // The plan's on/off answer, which is also what decides whether Settings shows the Billing tab at all.
        case `/rpc/hosted-plan`:
            return json(DEMO_HOSTED_PLAN);
        case `/rpc/invite/list`:
            return json({ invites: [] });
        case `/rpc/me`:
            return json(DEMO_USER);
        default:
            console.info(`[demo] no fixture route for the platform's ${request.method} ${path}`);
            return json({ message: `The demo doesn't serve ${path}.` }, 404);
    }
};
