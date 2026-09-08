import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES, sandboxRouteName } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

// What the active daemon can do, from its /events hello frame. A newer browser than daemon is normal, not an
// error; this turns a silent 404 into a named gap, so features can gate on `supportsRoute` instead of finding out
// by breaking. Two kinds of gap: a route the daemon lacks, or one it shapes differently; both are non-blocking.

// Route names the daemon advertises; undefined means unknown (not connected, or predates the hello field) and is
// read as fully supported.
const advertised = ref<ReadonlySet<string> | undefined>(undefined);

// Per-route shape fingerprint from the daemon's build; undefined (route or whole map) means no evidence, not
// mismatch.
const advertisedShapes = ref<Readonly<Record<string, string>> | undefined>(undefined);

// Called on every hello frame; nothing advertised leaves the assume-supported state.
export const setDaemonRoutes = (routes: readonly string[] | undefined, shapes?: Readonly<Record<string, string>>): void => {
    advertised.value = routes === undefined ? undefined : new Set(routes);
    advertisedShapes.value = shapes;
};

// Cleared on a sandbox switch, not a dropped connection, so one sandbox's surface isn't attributed to another.
export const resetDaemonRoutes = (): void => {
    advertised.value = undefined;
    advertisedShapes.value = undefined;
};

// An unknown daemon or route answers true; a feature only hides on positive evidence it's missing.
export const supportsRoute = (name: string): boolean => advertised.value === undefined || advertised.value.has(name);

// The undivided true/false/undefined answer, for useSandboxSession's fallback: a definite yes clears
// learned-by-404, a definite no skips probing.
export const routeAdvertised = (name: string): boolean | undefined => advertised.value?.has(name);

// How far behind the sandbox is; empty when the daemon is level or newer (extra daemon routes are never asked about).
export const missingRoutes = computed<string[]>(() => {
    const known = advertised.value;
    if (known === undefined) {
        return [];
    }
    return SANDBOX_ROUTE_NAMES.filter((name) => !known.has(name));
});

// True when the daemon is demonstrably older; informational in production, actionable (rebuild) in dev.
export const daemonBehind = computed(() => missingRoutes.value.length > 0);

// Compared only where both sides published a fingerprint; an unexpressed or unpublished shape is no evidence.
// Above this fraction disagreeing, it's cross-build schema rendering, not real drift, so the result is discarded.
const DRIFT_IS_NOISE_ABOVE = 0.5;

export const driftedRoutes = computed<string[]>(() => {
    const theirs = advertisedShapes.value;
    if (theirs === undefined) {
        return [];
    }
    const comparable = Object.keys(SANDBOX_ROUTE_SHAPES).filter((name) => theirs[name] !== undefined);
    const drifted = comparable.filter((name) => theirs[name] !== SANDBOX_ROUTE_SHAPES[name]);
    return comparable.length > 0 && drifted.length > comparable.length * DRIFT_IS_NOISE_ABOVE ? [] : drifted.toSorted();
});

// True when the daemon shapes a shared route differently; independent of `daemonBehind`.
export const daemonDrifted = computed(() => driftedRoutes.value.length > 0);

// What to do about a gap: a dev reloads the sandbox they just changed, a user updates the released image. In dev
// the daemon runs from the working tree, not the image, so a reload, not a rebuild, is what updates it.
const daemonOlderRemedy = (): string =>
    import.meta.env.DEV
        ? `This sandbox is running older code than this app: reload it with 'sh _sandbox/sandbox/scripts/dev-reload.sh'.`
        : `Update the sandbox to a newer image to use this feature.`;

// Drift never says which side moved: a page open since before the change is as likely stale as the daemon.
// Offers both remedies, cheapest first.
const eitherSideOlderRemedy = (): string =>
    import.meta.env.DEV
        ? `One of the two is running older code: reload this page, or the sandbox with 'sh _sandbox/sandbox/scripts/dev-reload.sh'.`
        : `Reload this page, or update the sandbox to a newer image.`;

// Why a request to `path` failed because this daemon predates the route; undefined for a non-contract path or one
// the daemon advertises. A missing route is directional: only a daemon behind lacks a name this app has.
export const staleDaemonReason = (method: string, path: string): string | undefined => {
    const name = sandboxRouteName(method, path);
    if (name === undefined || supportsRoute(name)) {
        return undefined;
    }
    return `This sandbox's daemon doesn't provide '${name}'. ${daemonOlderRemedy()}`;
};

// Why a request that reached its route still failed: the daemon has it, shaped differently, so it answers rather
// than 404s. Separate from staleDaemonReason since nothing in the HTTP status routes to this.
export const driftedRouteReason = (method: string, path: string): string | undefined => {
    const name = sandboxRouteName(method, path);
    if (name === undefined || !driftedRoutes.value.includes(name)) {
        return undefined;
    }
    return `This sandbox's daemon has '${name}' but exchanges different fields for it than this app expects. ${eitherSideOlderRemedy()}`;
};
