import { sandboxRef } from "@intentic/extension-api";
import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { z } from "zod";
import { contractUncompiled } from "./contractFreshness";

// What the active daemon can do, from its /events hello frame. A newer browser than daemon is normal, not an
// error; this turns a silent 404 into a named gap, so features can gate on `supportsRoute` instead of finding out
// by breaking. Two kinds of gap: a route the daemon lacks, or one it shapes differently; both are non-blocking.

// Route names the daemon advertises; undefined means unknown (not connected, or predates the hello field) and is
// read as fully supported. Sandbox-scoped, not dropped with a connection, so one sandbox's surface isn't attributed to
// another.
const advertised = sandboxRef<ReadonlySet<string> | undefined>(() => undefined);

// Per-route shape fingerprint from the daemon's build; undefined (route or whole map) means no evidence, not
// mismatch.
const advertisedShapes = sandboxRef<Readonly<Record<string, string>> | undefined>(() => undefined);

// Called on every hello frame; nothing advertised leaves the assume-supported state.
export const setDaemonRoutes = (routes: readonly string[] | undefined, shapes?: Readonly<Record<string, string>>): void => {
    advertised.value = routes === undefined ? undefined : new Set(routes);
    advertisedShapes.value = shapes;
};

// An unknown daemon or route answers true; a feature only hides on positive evidence it's missing.
export const supportsRoute = (name: string): boolean => advertised.value === undefined || advertised.value.has(name);

// How many calls each side names, which is what makes a drift count mean anything: "7 disagree" out of a surface
// neither side's size is stated for is a number with no scale. Undefined for a daemon that never said.
export const advertisedRouteCount = computed<number | undefined>(() => advertised.value?.size);
export const ourRouteCount = SANDBOX_ROUTE_NAMES.length;

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

// What to do about a gap: a dev restarts the sandbox they just changed, a user updates the released image. In dev
// the sandbox runs the checkout rather than the image, so a restart, not a rebuild, is what picks the change up.
// RESTART, NEVER RELOAD: this sentence reaches a browser console and an agent alike, and "reload" there is read as
// refreshing a page — which would leave the reader pressing F5 at a sandbox that needs restarting.
const daemonOlderRemedy = (): string =>
    import.meta.env.DEV
        ? `This sandbox is running older code than this app: restart it with 'sh _sandbox/sandbox/scripts/dev-restart.sh'.`
        : `Update the sandbox to a newer image to use this feature.`;

// Drift says which side moved only when something else has proved it. The dev server's reading comes first because it
// names a cause rather than a side, and rules the page reload out; then a route only this app knows leans the other
// way; otherwise neither side can be named and both remedies are offered, cheapest first.
const eitherSideOlderRemedy = (): string => {
    if (contractUncompiled.value) {
        return `The sandbox is running code older than this checkout: restart it with 'sh _sandbox/sandbox/scripts/dev-restart.sh', which rebuilds it first. Reloading this page won't help.`;
    }
    if (appBehind.value) {
        return `This page is running older code than the sandbox: reload the page.`;
    }
    return import.meta.env.DEV
        ? `One of the two is running older code: reload this page, or restart the sandbox with 'sh _sandbox/sandbox/scripts/dev-restart.sh'.`
        : `Reload this page, or update the sandbox to a newer image.`;
};

// Why a call to route `name` failed because this daemon predates it; undefined for one the daemon advertises. A
// missing route is directional: only a daemon behind lacks a name this app has.
export const staleDaemonReason = (name: string): string | undefined => {
    if (supportsRoute(name)) {
        return undefined;
    }
    return `This sandbox's daemon doesn't provide '${name}'. ${daemonOlderRemedy()}`;
};

// A schema refusing the daemon's answer is version drift no status code carries, and its issue list is developer JSON.
export const readFailure = (error: unknown): string => {
    if (error instanceof z.core.$ZodError) {
        return `This sandbox answered in a shape this app doesn't expect. ${eitherSideOlderRemedy()}`;
    }
    return error instanceof Error ? error.message : String(error);
};

// Why a call that reached route `name` still failed: the daemon has it, shaped differently, so it answers rather
// than 404s. Separate from staleDaemonReason since nothing in the HTTP status routes to this.
export const driftedRouteReason = (name: string): string | undefined => {
    if (!driftedRoutes.value.includes(name)) {
        return undefined;
    }
    return `This sandbox's daemon has '${name}' but exchanges different fields for it than this app expects. ${eitherSideOlderRemedy()}`;
};
