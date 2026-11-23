import type { SandboxSummary } from "@intentic/api-contract";
import { isHostedTierId } from "@intentic/constants";
import { topPath } from "@intentic/sandbox-contract/app-routes";
import type { LocationQuery, RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw } from "vue-router";
import { useSandbox } from "../client/sandbox/useSandbox";
import { sandboxLanding } from "../lib/routes/firstScreens";
import { finishOnHome } from "../models/sandbox/finishOnHome";
import { sandboxEntryPath } from "../models/sandbox/sandboxScreen";
import { ownCloudSandboxes } from "../models/sandbox/live/cloudSandboxes";
import { resolveUser } from "./sessionGuard";
import { homeForSetup } from "./setupRoutes";

// THE CLOUD ENTRY, `/start/hosted` (2026-11-23). Every "Start in your browser" on intentic.dev (the landing page, the
// guides, the download page, pricing's "Start a cloud sandbox") links here, and Stripe's checkout comes back here with the
// tier it sold. Before, the site's most-pressed browser buttons linked the bare app origin, which carries no ask: a
// stranger signed in and landed on a generic Home, and a returning visitor was offered a new sandbox they could not have
// (their free machine already in use) instead of the one they had. PostHog, 30 days to 2026-11-23: 54 outside visitors
// pressed "Or start in your browser", 33 signed in, 4 sandboxes connected.
//
// So the entry reads the account before it decides, and decides one of three things:
//   - signed out: sign in, coming back to this same address (`returnTo=/start/hosted…`, a plain same-origin path, which
//     survives Google's redirect, the typed email code and the emailed link alike), and Login says it is for a cloud
//     sandbox (features/auth/Login.vue `hosted`);
//   - a cloud sandbox of the reader's own already: open it, on its own first screen. Entering a sandbox whose machine was
//     stopped for want of use wakes it (client/sandbox/useSandbox.ts `select`, and the connection's own wake on a failed
//     dial), and its page says so while it starts, so the visitor is back in their conversation rather than in the add
//     dialog. One whose setup never finished is finished on Home, on its machine;
//   - otherwise: Home's new sandbox dialog with a machine of ours picked (router/setupRoutes.ts `homeForSetup`).
// A tier named by the address (pricing, or checkout coming back from a sale) always means a NEW machine of that tier: a
// purchase must never fall back to opening the free one.

/** Where the cloud entry sends a signed-in reader, from the account's sandbox list and the entry's own address. */
export type HostedArrival =
    | { readonly kind: `open`; readonly sandboxId: string }
    | { readonly kind: `finish`; readonly sandboxId: string }
    | { readonly kind: `create` };

/** The decision itself, pure: the cloud sandbox to open or finish, or a new one. */
export const hostedArrival = (rows: readonly SandboxSummary[], query: LocationQuery): HostedArrival => {
    if (isHostedTierId(query[`tier`])) {
        return { kind: `create` };
    }
    const own = ownCloudSandboxes(rows);
    const working = own.find((row) => row.lastSeenAt !== null);
    if (working !== undefined) {
        return { kind: `open`, sandboxId: working.id };
    }
    const unfinished = own.find((row) => row.lastSeenAt === null);
    return unfinished === undefined ? { kind: `create` } : { kind: `finish`, sandboxId: unfinished.id };
};

/**
 * The address a decision lands on. A sandbox opened lands where `entry` says: the guard's is the screen this window last
 * left it on (its agent's chat, say), else its board, where the first agent's card is.
 */
export const hostedArrivalPath = (
    arrival: HostedArrival,
    to: Pick<RouteLocationNormalized, `path` | `query`>,
    entry: (sandboxId: string) => string = (sandboxId) => sandboxLanding(sandboxId, { isGuest: false, homeOnly: false }),
): RouteLocationRaw => {
    switch (arrival.kind) {
        case `open`:
            return entry(arrival.sandboxId);
        case `finish`: {
            const finish = finishOnHome(arrival.sandboxId);
            return { path: finish.path, query: { ...finish.query, machine: `hosted` } };
        }
        default:
            return homeForSetup(to.path, to.query);
    }
};

/** The route's guard: sign-in first, then the account's list, then the decision. Never answers `true`: it is only a way in. */
export const hostedEntry = async (to: RouteLocationNormalized): Promise<RouteLocationRaw> => {
    const resolved = await resolveUser(to);
    if (!(`user` in resolved)) {
        return resolved.redirect;
    }
    const rows = await useSandbox()
        .list()
        // allow(silent-catch): a list the platform could not give is the shell gate's to say; Home's ask is a safe landing.
        .catch(() => undefined);
    return hostedArrivalPath(rows === undefined ? { kind: `create` } : hostedArrival(rows, to.query), to, sandboxEntryPath);
};

// Named still (`{ name: "hosted-start" }`), as it was while it only redirected. Its guard always answers with somewhere
// else, so the component is never drawn; the route table needs one.
export const hostedStartRoute: RouteRecordRaw = {
    path: topPath(`startHosted`),
    name: `hosted-start`,
    beforeEnter: [hostedEntry],
    component: { render: () => null },
};
