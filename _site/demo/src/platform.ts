import type { HostedPlanState, SandboxSummary, User } from "@intentic/api-contract";
import { DEMO_DAEMON_ORIGIN, json } from "./transport";

// Fetch handler for the three router gates before the workspace renders:
// GET /api/auth/get-session — session probe
// GET /rpc/sandbox/list — zero sandboxes bounces to /setup
// GET /rpc/billing/plan — the account badge, read lazily
// `daemonUrl` points the sandbox client at the demo daemon's origin.

export const DEMO_USER: User = { id: `demo-user`, email: `ada@acme.dev`, name: `Ada Lovelace`, image: null };

export const DEMO_SANDBOX: SandboxSummary = {
    id: `demo`,
    name: `acme-shop`,
    image: null,
    daemonUrl: DEMO_DAEMON_ORIGIN,
    lastSeenAt: new Date().toISOString(),
    setupCodeClaimedAt: null,
    // Null: sandbox is already up, so no setup wizard run ever reported on it.
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    token: `demo-connect-token`,
    role: `owner`,
    providedAddress: false,
    // Null: no real container or CA-signed cert to offer a loopback shortcut from.
    localHostname: null,
    // Local sandbox, not a machine the platform hosts.
    hosted: null,
};

// Account on the hosted plan, which is why Settings shows the Billing tab at all.
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
        // Only get-session matters; others must not 404 or better-auth reads it as signed-out.
        return json(path.endsWith(`/get-session`) ? SESSION : { ok: true });
    }

    switch (path) {
        case `/rpc/sandbox/list`:
            return json({ sandboxes: [DEMO_SANDBOX] });
        case `/rpc/billing/plan`:
            return json({ plan: `pro`, entitlements: { sandboxes: 5, members: 10 } });
        // Plan's on/off answer decides whether Settings shows the Billing tab.
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
