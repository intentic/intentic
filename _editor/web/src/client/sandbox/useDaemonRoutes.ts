import { errorMessage } from "@intentic/base/errors";
import { sandboxRef } from "@intentic/extension-api";
import type { Hello } from "@intentic/sandbox-contract/events/system-events";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { z } from "zod";
import { contractModule } from "./daemon/contract";
import { contractUncompiled } from "./contractFreshness";
import { routeArea } from "./daemon/routeAreas";
import type { RefusalWords } from "./sandboxHttpError";

// What the active daemon can do, from its /events hello frame. A newer browser than daemon is normal, not an
// error; this turns a silent 404 into a named gap, so features can gate on `supportsRoute` instead of finding out
// by breaking. Two kinds of gap: a route the daemon lacks, or one it shapes differently; both are non-blocking.

// What answers: a sandbox's daemon, or the desktop app's sidecar serving a folder on this computer. A folder lacks most
// routes by nature rather than by age, so it is never "behind" and its gaps are never an update away.
export type DaemonSurface = NonNullable<Hello["surface"]>;

// The last hello of a folder's sidecar. Every folder a desktop window shows is served by the app's one sidecar, so what
// it advertised still holds for another folder pointed at in the window's place (local/folderSwitch.ts), until that
// folder's own hello says otherwise. A switch back to a folder last seen online is reachable at once, before its hello,
// and would otherwise read every route a sandbox has as served, and ask the sidecar for them. A sandbox's daemon is
// another machine of another age, so nothing of its hello is carried across a switch.
let sidecarHello: { readonly routes: ReadonlySet<string> | undefined; readonly shapes: Readonly<Record<string, string>> | undefined } | undefined;

// A raw route is keyed `METHOD /path` and a procedure `group.name`; the space is the whole difference, and the two are
// advertised on fields of their own, so every check below has to know which of the two it is holding.
const isRawRoute = (name: string): boolean => name.includes(` `);

// Route names the daemon advertises; undefined means unknown (not connected yet, no hello read) and is read as fully
// supported. Sandbox-scoped, not dropped with a connection, so one sandbox's surface isn't attributed to
// another.
const advertised = sandboxRef<ReadonlySet<string> | undefined>(() => sidecarHello?.routes);

// Per-route shape fingerprint from the daemon's build; undefined (route or whole map) means no evidence, not
// mismatch.
const advertisedShapes = sandboxRef<Readonly<Record<string, string>> | undefined>(() => sidecarHello?.shapes);

// The daemon's hand-written routes and their fingerprints, advertised on fields of their own since a browser older
// than the daemon reads an unfamiliar name in `routes` as evidence about which side is stale. Undefined is a daemon
// from before those fields, and reads as assume-supported exactly like an unknown procedure surface. A folder's
// sidecar sends neither: it lists what few raw routes it serves among `routes`, and ships in one build with this page.
const advertisedRaw = sandboxRef<ReadonlySet<string> | undefined>(() => undefined);
const advertisedRawPrints = sandboxRef<Readonly<Record<string, string>> | undefined>(() => undefined);

const advertisedSurface = sandboxRef<DaemonSurface>(() => (sidecarHello === undefined ? `sandbox` : `folder`));

// Called on every hello frame; nothing advertised leaves the assume-supported state. A hello that names no surface is
// a daemon's, from before the field.
export const setDaemonRoutes = (
    routes: readonly string[] | undefined,
    shapes?: Readonly<Record<string, string>>,
    surface?: DaemonSurface,
    raw?: Pick<Hello, `rawRoutes` | `rawFingerprints`>,
): void => {
    advertised.value = routes === undefined ? undefined : new Set(routes);
    advertisedShapes.value = shapes;
    advertisedRaw.value = raw?.rawRoutes === undefined ? undefined : new Set(raw.rawRoutes);
    advertisedRawPrints.value = raw?.rawFingerprints;
    advertisedSurface.value = surface ?? `sandbox`;
    sidecarHello = surface === `folder` ? { routes: advertised.value, shapes } : undefined;
};

// True for a window on a folder of this computer (the desktop app's local face).
export const folderSurface = computed(() => advertisedSurface.value === `folder`);

// Which set names routes of this one's kind: a folder lists the few raw routes it serves among `routes`, a daemon
// advertises them apart. Undefined either way means the surface was never stated.
const advertisedFor = (name: string): ReadonlySet<string> | undefined =>
    isRawRoute(name) && !folderSurface.value ? advertisedRaw.value : advertised.value;

// An unknown daemon or route answers true; a feature only hides on positive evidence it's missing.
export const supportsRoute = (name: string): boolean => {
    const known = advertisedFor(name);
    return known === undefined || known.has(name);
};

// How many calls each side names, which is what makes a drift count mean anything: "7 disagree" out of a surface
// neither side's size is stated for is a number with no scale. Undefined for a daemon that never said.
export const advertisedRouteCount = computed<number | undefined>(() =>
    advertised.value === undefined ? undefined : advertised.value.size + (advertisedRaw.value?.size ?? 0),
);
// This build's own route names, as lists and sets, for the two directions of comparison below. They come with the
// contract, which loads beside the start (daemon/contract.ts): until it lands there are none, and every comparison below then
// answers as it does for a daemon that has said nothing — no evidence either way, never "behind" — and answers again
// when it lands.
const ownRoutes = computed(() => {
    const contract = contractModule.value;
    return contract === undefined
        ? undefined
        : {
              names: contract.SANDBOX_ROUTE_NAMES,
              rawNames: contract.RAW_ROUTE_NAMES,
              set: new Set(contract.SANDBOX_ROUTE_NAMES),
              rawSet: new Set(contract.RAW_ROUTE_NAMES),
          };
});

export const ourRouteCount = computed(() => (ownRoutes.value === undefined ? 0 : ownRoutes.value.names.length + ownRoutes.value.rawNames.length));

// How far behind the sandbox is; empty when the daemon is level or newer (extra daemon routes are never asked about).
// Each kind is read off its own field, so a daemon that advertises procedures and not raw routes is checked on
// procedures and assumed level on the rest, rather than reading as missing every raw route there is.
export const missingRoutes = computed<string[]>(() => {
    const own = ownRoutes.value;
    if (folderSurface.value || own === undefined) {
        return [];
    }
    const known = advertised.value;
    const knownRaw = advertisedRaw.value;
    return [
        ...(known === undefined ? [] : own.names.filter((name) => !known.has(name))),
        ...(knownRaw === undefined ? [] : own.rawNames.filter((name) => !knownRaw.has(name))),
    ];
});

// True when the daemon is demonstrably older; informational in production, actionable (rebuild) in dev.
export const daemonBehind = computed(() => missingRoutes.value.length > 0);

// Routes this daemon offers that this build has no name for: positive evidence the BROWSER is the older side. Ordinary
// on its own — a tab left open across a sandbox update is exactly this — so it never raises a warning by itself. It
// only says which way a disagreement leans once something else has already proved there is one.
export const unknownDaemonRoutes = computed<string[]>(() => {
    const own = ownRoutes.value;
    if (folderSurface.value || own === undefined) {
        return [];
    }
    const known = advertised.value;
    const knownRaw = advertisedRaw.value;
    return [
        ...(known === undefined ? [] : [...known].filter((name) => !own.set.has(name))),
        ...(knownRaw === undefined ? [] : [...knownRaw].filter((name) => !own.rawSet.has(name))),
    ].toSorted();
});

export const appBehind = computed(() => unknownDaemonRoutes.value.length > 0);

// Both kinds of route under one name → fingerprint map, which is what the comparison below reads: the kinds disagree
// the same way and are read off the same evidence, so only the two hellos' fields keep them apart.
const ourFingerprints = (): Readonly<Record<string, string>> => {
    const contract = contractModule.value;
    return contract === undefined ? {} : { ...contract.sandboxRouteFingerprints(), ...contract.rawRouteFingerprints() };
};
const theirFingerprints = computed<Readonly<Record<string, string>> | undefined>(() =>
    advertisedShapes.value === undefined && advertisedRawPrints.value === undefined
        ? undefined
        : { ...advertisedShapes.value, ...advertisedRawPrints.value },
);

// Routes both sides published a fingerprint for: the only ones a disagreement can be read off. An unexpressed or
// unpublished shape is no evidence, not a match.
const comparableRoutes = computed<string[]>(() => {
    const theirs = theirFingerprints.value;
    return theirs === undefined ? [] : Object.keys(ourFingerprints()).filter((name) => theirs[name] !== undefined);
});

// The denominator a drift count is only meaningful against: "3 routes disagree" says nothing without how many were
// checked, and an old daemon publishing few shapes is checked on few.
export const comparedRouteCount = computed(() => comparableRoutes.value.length);

export const driftedRoutes = computed<string[]>(() => {
    const theirs = theirFingerprints.value;
    const ours = ourFingerprints();
    return theirs === undefined ? [] : comparableRoutes.value.filter((name) => theirs[name] !== ours[name]).toSorted();
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
        : t(`sandbox.useDaemonRoutes.updateImage`);

// Drift says which side moved only when something else has proved it. The dev server's reading comes first because it
// names a cause rather than a side, and rules the page reload out; then a route only this app knows leans the other
// way; otherwise neither side can be named and both remedies are offered, cheapest first.
const eitherSideOlderRemedy = (): string => {
    if (contractUncompiled.value) {
        return `The sandbox is running code older than this checkout: restart it with 'sh _sandbox/sandbox/scripts/dev-restart.sh', which rebuilds it first. Reloading this page won't help.`;
    }
    if (appBehind.value) {
        return t(`sandbox.useDaemonRoutes.pageOlder`);
    }
    return import.meta.env.DEV
        ? `One of the two is running older code: reload this page, or restart the sandbox with 'sh _sandbox/sandbox/scripts/dev-restart.sh'.`
        : t(`sandbox.useDaemonRoutes.reloadOrUpdate`);
};

// The part of the app a route serves, as the sentences below name it. A shipped build says the area in plain words
// (routeAreas.ts) and never the dotted route id, which means nothing to anyone outside this codebase; a dev build adds
// the id, which is what a fix is written against. Undefined for a route of no named area in a shipped build, whose
// sentence then names no area at all.
const areaOf = (name: string): string | undefined => {
    const label = routeArea(name)?.label;
    if (!import.meta.env.DEV) {
        return label;
    }
    return label === undefined ? name : `${label}: ${name}`;
};

// Why a call to route `name` failed because this daemon predates it; undefined for one the daemon advertises. A
// missing route is directional: only a daemon behind lacks a name this app has. A folder on this computer never has
// it, and no update brings it.
export const staleDaemonReason = (name: string): string | undefined => {
    if (supportsRoute(name)) {
        return undefined;
    }
    const area = areaOf(name);
    if (folderSurface.value) {
        return area === undefined ? t(`sandbox.useDaemonRoutes.folderLacksUnnamed`) : t(`sandbox.useDaemonRoutes.folderLacks`, { area });
    }
    const remedy = daemonOlderRemedy();
    return area === undefined ? t(`sandbox.useDaemonRoutes.routeMissingUnnamed`, { remedy }) : t(`sandbox.useDaemonRoutes.routeMissing`, { area, remedy });
};

// A schema refusing the daemon's answer is version drift no status code carries, and its issue list is developer JSON.
export const readFailure = (error: unknown): string => {
    if (error instanceof z.core.$ZodError) {
        return t(`sandbox.useDaemonRoutes.unexpectedShape`, { remedy: eitherSideOlderRemedy() });
    }
    return errorMessage(error);
};

// Why a call that reached route `name` still failed: the daemon has it, shaped differently, so it answers rather
// than 404s. Separate from staleDaemonReason since nothing in the HTTP status routes to this.
export const driftedRouteReason = (name: string): string | undefined => {
    if (!driftedRoutes.value.includes(name)) {
        return undefined;
    }
    const area = areaOf(name);
    const remedy = eitherSideOlderRemedy();
    return area === undefined ? t(`sandbox.useDaemonRoutes.routeDriftedUnnamed`, { remedy }) : t(`sandbox.useDaemonRoutes.routeDrifted`, { area, remedy });
};

// Ends the daemon's words as a sentence, so the drift's own sentence can follow them.
const asSentence = (words: string): string => (/[.!?…]$/u.test(words.trimEnd()) ? words.trimEnd() : `${words.trimEnd()}.`);

// How a refusal from the active daemon on route `name` reads, where the routes say more than its words; undefined where
// they don't, and the daemon's words stand alone. A 404 on a route it never advertised is that daemon being older,
// whatever it answered. A 400 on a route the two shape differently keeps the daemon's words first: they name what it
// refused, which is often nothing the drift touched (a title past its cap, a path outside the workspace), and putting
// the drift in their place sent the reader to restart a sandbox over a field that would be refused by any version. The
// drift follows, as what may lie behind it.
export const routeRefusalText = (name: string, status: number, said: RefusalWords): string | undefined => {
    if (status === 404) {
        return staleDaemonReason(name);
    }
    const drift = status === 400 ? driftedRouteReason(name) : undefined;
    const own = said.message ?? said.error;
    return drift === undefined || own === undefined ? drift : `${asSentence(own)} ${drift}`;
};
