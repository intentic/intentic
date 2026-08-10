import { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES, sandboxRouteName } from "@intentic/sandbox-contract";
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
 * TWO KINDS OF GAP, because a route surface has two ways to disagree. A route the daemon LACKS answers 404 and
 * is caught by name (`missingRoutes`). A route it HAS but shapes differently answers 200 with the wrong fields
 * in it — no status code to notice, nothing to attribute it to — and is caught by fingerprint
 * (`driftedRoutes`). Both are non-blocking: an older sandbox is a supported thing to be running, and neither
 * check ever refuses a call. They only stop the disagreement being invisible.
 *
 * Module-level singleton, like the rest of the sandbox stores. Fed only by useSandboxLiveness. */

// Route names the active daemon advertises, or undefined when it hasn't said (not connected yet, or a daemon
// built before the hello frame carried `routes`). Undefined means ASSUME SUPPORTED: a daemon that predates the
// advertisement is not one we can interrogate, so nothing may be gated on its silence.
const advertised = ref<ReadonlySet<string> | undefined>(undefined);

// The fingerprint the daemon advertises for each route it can express, from ITS build of the contract. Same
// undefined-means-assume-compatible rule as `advertised` above, and a route absent from a daemon that DID send
// the map is in the same position: the contract has shapes it cannot express (streaming routes), so a missing
// entry is "no evidence" rather than "no match".
const advertisedShapes = ref<Readonly<Record<string, string>> | undefined>(undefined);

// Called on every hello frame. A daemon that advertises nothing leaves us in the assume-supported state.
export const setDaemonRoutes = (routes: readonly string[] | undefined, shapes?: Readonly<Record<string, string>>): void => {
    advertised.value = routes === undefined ? undefined : new Set(routes);
    advertisedShapes.value = shapes;
};

// A dropped connection tells us nothing new about the daemon's build, but a SWITCH to another sandbox does:
// the next hello re-advertises. Cleared on switch so one sandbox's surface is never attributed to another.
export const resetDaemonRoutes = (): void => {
    advertised.value = undefined;
    advertisedShapes.value = undefined;
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

/* Routes BOTH builds have, whose payload shape they disagree about — the failure `missingRoutes` structurally
 * cannot see. Compared only where both sides published a fingerprint: a route this build cannot express, or one
 * the daemon didn't publish, has no evidence either way and is left alone.
 *
 * The near-total case is thrown away deliberately. These fingerprints come out of `z.toJSONSchema`, so a daemon
 * and a browser built against different zod versions can render the SAME schema differently and disagree about
 * every route at once. That is a fact about the two builds' toolchains, not about any feature — and a list of
 * 200 drifted routes tells a user nothing they can act on, which is how a warning teaches people to ignore it.
 * Real drift is a handful of routes someone just edited. */
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

// True when the daemon answers a different shape on routes it shares with this app. Independent of
// `daemonBehind`: a daemon can be level on every route name and still shape one of them differently.
export const daemonDrifted = computed(() => driftedRoutes.value.length > 0);

// The two audiences differ only in what they can do about it: a developer rebuilds the image they just changed,
// a user updates the sandbox someone else released.
const imageRemedy = (): string =>
    import.meta.env.DEV
        ? `Your dev image predates it — run 'pnpm build:sandbox && sh _sandbox/sandbox/scripts/dev-sandbox.sh'.`
        : `Update the sandbox to a newer image to use this feature.`;

// The reason a request to `path` failed, when the cause is that this daemon predates the route. Undefined when
// the path is not a contract route, or is one the daemon advertises — in which case the 404 is a real 404 and
// must be reported verbatim rather than blamed on the image.
export const staleDaemonReason = (method: string, path: string): string | undefined => {
    const name = sandboxRouteName(method, path);
    if (name === undefined || supportsRoute(name)) {
        return undefined;
    }
    return `This sandbox's daemon doesn't provide '${name}'. ${imageRemedy()}`;
};

/* The reason a request that REACHED its route still didn't work — the daemon has it, under a different shape.
 *
 * Separate from `staleDaemonReason` because it hangs off a different failure: a drifted route does not 404, it
 * answers, and the answer is missing a field or rejects a field that was sent. So this is what a caller reaches
 * for when a call succeeded on the wire and failed to make sense, rather than something the HTTP status alone
 * can route to. */
export const driftedRouteReason = (method: string, path: string): string | undefined => {
    const name = sandboxRouteName(method, path);
    if (name === undefined || !driftedRoutes.value.includes(name)) {
        return undefined;
    }
    return `This sandbox's daemon has '${name}' but exchanges different fields for it than this app expects. ${imageRemedy()}`;
};
