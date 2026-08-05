import { SANDBOX_ROUTE_NAMES, sandboxRouteName } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

/* What the ACTIVE daemon can actually do, as advertised on its /events hello frame.
 *
 * The browser is routinely newer than the daemon it talks to, and that is a supported state, not an error: the
 * released app plane serves every user's sandbox whatever image they last pulled, and in local development the
 * web app runs from the working tree while the daemon is baked into the last `pnpm build:sandbox`. Neither
 * should force an update — an older sandbox must keep working for everything it does implement.
 *
 * What this store removes is the SILENCE. Before it, a route the daemon predates answered 404, indistinguishable
 * from "that file doesn't exist", so a missing feature read as a broken one and the only way to find out was to
 * rebuild the image and see. Now the gap has a name: features can gate on `supportsRoute` before offering
 * themselves, and a 404 on a route the daemon never advertised is reported as exactly that (sandboxClient).
 *
 * Module-level singleton, like the rest of the sandbox stores. Fed only by useSandboxLiveness. */

// Route names the active daemon advertises, or undefined when it hasn't said (not connected yet, or a daemon
// built before the hello frame carried `routes`). Undefined means ASSUME SUPPORTED: a daemon that predates the
// advertisement is not one we can interrogate, so nothing may be gated on its silence.
const advertised = ref<ReadonlySet<string> | undefined>(undefined);

// Called on every hello frame. A daemon that advertises nothing leaves us in the assume-supported state.
export const setDaemonRoutes = (routes: readonly string[] | undefined): void => {
    advertised.value = routes === undefined ? undefined : new Set(routes);
};

// A dropped connection tells us nothing new about the daemon's build, but a SWITCH to another sandbox does:
// the next hello re-advertises. Cleared on switch so one sandbox's surface is never attributed to another.
export const resetDaemonRoutes = (): void => {
    advertised.value = undefined;
};

// Can the active daemon serve this contract route? Unknown daemons (and unknown route names) answer true — the
// UI only ever hides a feature it has POSITIVE evidence is missing.
export const supportsRoute = (name: string): boolean => advertised.value === undefined || advertised.value.has(name);

// The three-way answer supportsRoute folds away: true/false from a hello frame, undefined while nothing is
// advertised (not connected yet, or a pre-advertisement daemon). useSandboxSession needs the distinction — a
// positive "yes" clears its learned-by-404 fallback, a positive "no" skips the exchange without probing.
export const routeAdvertised = (name: string): boolean | undefined => advertised.value?.has(name);

// Routes this browser's contract has that the daemon does not — i.e. how far behind the sandbox is. Empty when
// the daemon is level or newer (a daemon ahead of us simply advertises names we never ask about).
export const missingRoutes = computed<string[]>(() => {
    const known = advertised.value;
    if (known === undefined) {
        return [];
    }
    return SANDBOX_ROUTE_NAMES.filter((name) => !known.has(name));
});

// True when the active daemon is demonstrably older than this app. Drives the "your sandbox is behind" notice —
// informational in production (an old sandbox is allowed), actionable in dev (rebuild the image).
export const daemonBehind = computed(() => missingRoutes.value.length > 0);

// The reason a request to `path` failed, when the cause is that this daemon predates the route. Undefined when
// the path is not a contract route, or is one the daemon advertises — in which case the 404 is a real 404 and
// must be reported verbatim rather than blamed on the image.
export const staleDaemonReason = (method: string, path: string): string | undefined => {
    const name = sandboxRouteName(method, path);
    if (name === undefined || supportsRoute(name)) {
        return undefined;
    }
    // The two audiences differ only in what they can do about it: a developer rebuilds the image they just
    // changed, a user updates the sandbox someone else released.
    const remedy = import.meta.env.DEV
        ? `Your dev image predates it — run 'pnpm build:sandbox && sh _sandbox/sandbox/scripts/dev-sandbox.sh'.`
        : `Update the sandbox to a newer image to use this feature.`;
    return `This sandbox's daemon doesn't provide '${name}'. ${remedy}`;
};
