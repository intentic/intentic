import type { DaemonHealth } from "@intentic/sandbox-contract/schemas/system";
import { rowAt } from "./sandboxRegistry";

// WHERE A SANDBOX ANSWERS IN THE DEMO'S WORLD. Every address of the demo's own is under the reserved `.demo.invalid` TLD,
// so a request that escapes the handlers dies there rather than reaching a real host. One kind of address cannot be: the
// one a visitor types into "One already running" (Add sandbox), which is any https host at all. The demo's world has a
// sandbox answering at every such address the visitor names (it is their own server, by the form's own premise), so the
// attach probe's two requests are claimed for any https origin, and an origin that answered one joins the sandboxes'
// addresses for every request after: the rest of its daemon routes, its sockets. A host whose name says it is down
// (`offline`, `down` or `nothing` as one of its labels) answers as nothing at all, so the failure is there to see too.

// The probe's two reads (features/setup/setupAttach.ts `probeDaemon`): /health unauthenticated, then /environment.
const PROBE_PATHS = new Set([`/health`, `/environment`]);
// Addresses a probe reached, which now answer as sandboxes for everything.
const answering = new Set<string>();

const isDemoHost = (url: URL): boolean => url.hostname.endsWith(`demo.invalid`);

/** A host named as down: answers nothing, the way an address with no sandbox behind it fails a fetch. */
export const answersNothing = (url: URL): boolean => /(^|[.-])(offline|down|nothing)([.-]|$)/i.test(url.hostname);

/** Whether this request goes to a sandbox of the demo's world: its own addresses, or one the visitor has named. */
export const sandboxAddress = (url: URL, method: string): boolean => {
    if (isDemoHost(url) || answering.has(url.origin)) {
        return true;
    }
    // Only another site's https address can be a sandbox somebody runs; the page's own origin serves the app.
    if (url.protocol !== `https:` || url.origin === globalThis.location?.origin || method !== `GET` || !PROBE_PATHS.has(url.pathname)) {
        return false;
    }
    if (!answersNothing(url)) {
        answering.add(url.origin);
    }
    return true;
};

/** Whether a WebSocket to this address goes to a sandbox of the demo's world. */
export const sandboxSocket = (url: URL): boolean => url.protocol === `wss:` && (isDemoHost(url) || answering.has(`https://${url.host}`));

// The endpoint selector's loopback candidates (`127.0.0.1:<port>` and `local-<digest>.<zone>`): nothing listens there in
// a browser tab, so they answer as no daemon at all and the selector keeps the public address.
const loopback = (url: URL): boolean => url.hostname === `127.0.0.1` || url.hostname.startsWith(`local-`);

/** GET /health at a sandbox's address, as a booted daemon answers it; undefined where no daemon listens. */
export const healthAt = (url: URL): DaemonHealth | undefined => {
    if (loopback(url)) {
        return undefined;
    }
    const row = rowAt(url.origin);
    const health: DaemonHealth = {
        ok: true,
        profile: `self-hosted`,
        boot: { ready: true, startedAt: Date.now() - 60_000, steps: [] },
        state: { journal: `none`, engine: 0 },
        announce: { state: `registered` },
        reach: { state: `reachable` },
        reachedBy: `tunnel`,
        build: { version: `demo`, commit: `demo`, builtAt: `2026-10-27T00:00:00.000Z` },
        atRestEncryption: { active: false, stores: [] },
        signIn: { proofs: [`google`, `email`] },
    };
    if (row !== undefined) {
        health.sandboxId = row.id;
    }
    return health;
};
