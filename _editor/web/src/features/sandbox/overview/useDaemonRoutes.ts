import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES, sandboxRouteName } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { contractUncompiled } from "./contractFreshness";

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

// This build's own route names, as a set, for the two directions of comparison below.
const OURS: ReadonlySet<string> = new Set(SANDBOX_ROUTE_NAMES);

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

// Routes this daemon offers that this build has no name for: positive evidence the BROWSER is the older side. Ordinary
// on its own — a tab left open across a sandbox update is exactly this — so it never raises a warning by itself. It
// only says which way a disagreement leans once something else has already proved there is one.
export const unknownDaemonRoutes = computed<string[]>(() => {
    const known = advertised.value;
    return known === undefined ? [] : [...known].filter((name) => !OURS.has(name)).toSorted();
});

export const appBehind = computed(() => unknownDaemonRoutes.value.length > 0);

// Routes both sides published a fingerprint for: the only ones a disagreement can be read off. An unexpressed or
// unpublished shape is no evidence, not a match.
const comparableRoutes = computed<string[]>(() => {
    const theirs = advertisedShapes.value;
    return theirs === undefined ? [] : Object.keys(SANDBOX_ROUTE_SHAPES).filter((name) => theirs[name] !== undefined);
});

// The denominator a drift count is only meaningful against: "3 routes disagree" says nothing without how many were
// checked, and an old daemon publishing few shapes is checked on few.
export const comparedRouteCount = computed(() => comparableRoutes.value.length);

export const driftedRoutes = computed<string[]>(() => {
    const theirs = advertisedShapes.value;
    return theirs === undefined ? [] : comparableRoutes.value.filter((name) => theirs[name] !== SANDBOX_ROUTE_SHAPES[name]).toSorted();
});

// Above this fraction, the two contracts disagree as wholes rather than in places: a different build entirely, a
// different zod, or a contract compiled from other source. Naming the areas then indicts most of the product for one
// cause, so the scope is reported instead — never discarded, which is what the old threshold did and which answered
// the worst case there is, everything broken, with silence.
const WHOLESALE_ABOVE = 0.5;

export type DriftScope = "none" | "partial" | "wholesale";

export const driftScope = computed<DriftScope>(() => {
    const drifted = driftedRoutes.value.length;
    if (drifted === 0) {
        return "none";
    }
    return drifted > comparableRoutes.value.length * WHOLESALE_ABOVE ? "wholesale" : "partial";
});

// True when the daemon shapes a shared route differently; independent of `daemonBehind`.
export const daemonDrifted = computed(() => driftedRoutes.value.length > 0);

// What to do about a gap: a dev reloads the sandbox they just changed, a user updates the released image. In dev
// the daemon runs from the working tree, not the image, so a reload, not a rebuild, is what updates it.
const daemonOlderRemedy = (): string =>
    import.meta.env.DEV
        ? `This sandbox is running older code than this app: reload it with 'sh _sandbox/sandbox/scripts/dev-reload.sh'.`
        : `Update the sandbox to a newer image to use this feature.`;

// Drift says which side moved only when something else has proved it. The dev server's reading comes first because it
// names a cause rather than a side, and rules the page reload out; then a route only this app knows leans the other
// way; otherwise neither side can be named and both remedies are offered, cheapest first.
const eitherSideOlderRemedy = (): string => {
    if (contractUncompiled.value) {
        return `The contract has changed since it was last compiled, and the sandbox runs the compiled copy: reload the sandbox with 'sh _sandbox/sandbox/scripts/dev-reload.sh', which rebuilds it. Reloading this page won't help.`;
    }
    if (appBehind.value) {
        return `This page is running older code than the sandbox: reload it.`;
    }
    return import.meta.env.DEV
        ? `One of the two is running older code: reload this page, or the sandbox with 'sh _sandbox/sandbox/scripts/dev-reload.sh'.`
        : `Reload this page, or update the sandbox to a newer image.`;
};

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
