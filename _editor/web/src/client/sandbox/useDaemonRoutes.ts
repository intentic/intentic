import { errorMessage } from "@intentic/base/errors";
import { sandboxShallowRef } from "@intentic/extension-api";
import type { Hello } from "@intentic/sandbox-contract/events/system-events";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { z } from "zod";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { contractModule } from "./daemon/contract";
import { onSandboxDropped } from "./scope/perSandbox";
import { contractUncompiled } from "./contractFreshness";
import { routeArea } from "./daemon/routeAreas";
import type { RefusalWords } from "./sandboxHttpError";

// What each daemon can do, from its /events hello frame; every export below speaks of the active one. A newer browser than daemon is normal, not an
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

// One daemon's hello, as everything below reads it. Every field undefined means unknown (not connected yet, no hello read)
// and is read as fully supported.
export interface DaemonSurfaceRecord {
    // Route names the daemon advertises.
    readonly routes: ReadonlySet<string> | undefined;
    // Per-route shape fingerprint from the daemon's build; undefined (route or whole map) means no evidence, not
    // mismatch.
    readonly shapes: Readonly<Record<string, string>> | undefined;
    // The daemon's hand-written routes and their fingerprints, advertised on fields of their own since a browser older
    // than the daemon reads an unfamiliar name in `routes` as evidence about which side is stale. Undefined is a daemon
    // from before those fields, and reads as assume-supported exactly like an unknown procedure surface. A folder's
    // sidecar sends neither: it lists what few raw routes it serves among `routes`, and ships in one build with this page.
    readonly raw: ReadonlySet<string> | undefined;
    readonly rawPrints: Readonly<Record<string, string>> | undefined;
    // Every route's second print, `[wire, core]` (sandbox-contract protocol/routes.ts `RoutePrints`), from a daemon recent
    // enough to send it. With it a route both sides shape differently splits in two: a different core may misbehave, and a
    // different wire over the same core is only an optional part one side lacks. Undefined is a daemon from before the
    // field, compared on the first print alone, as before.
    readonly prints: Readonly<Record<string, readonly [string, string]>> | undefined;
    readonly surface: DaemonSurface;
}

// What a window knows before any hello of its own: nothing, or what the folder sidecar last said (above).
const unheard = (): DaemonSurfaceRecord => ({
    routes: sidecarHello?.routes,
    shapes: sidecarHello?.shapes,
    raw: undefined,
    rawPrints: undefined,
    prints: undefined,
    surface: sidecarHello === undefined ? `sandbox` : `folder`,
});

// Each sandbox's last hello, by id. Sandbox-scoped like the rest of the window's state: emptied on every switch (and
// the active one's entry with a workspace replaced under its id, perSandbox.ts), so one sandbox's surface is never
// attributed to another, and a sandbox switched back to is unknown until its own hello again, as before.
const surfaces = sandboxShallowRef<ReadonlyMap<string, DaemonSurfaceRecord>>(() => new Map());
onSandboxDropped({
    drop: (id) => {
        if (surfaces.value.has(id)) {
            const next = new Map(surfaces.value);
            next.delete(id);
            surfaces.value = next;
        }
    },
    clear: () => {
        surfaces.value = new Map();
    },
});

// The active sandbox's record: its entry, or, before its hello (and with no sandbox chosen), what the window held when
// its scope began. Captured at the scope's start like every sandboxRef, so the sidecar's carry-over is read once per switch.
const unheardActive = sandboxShallowRef<DaemonSurfaceRecord>(unheard);
const activeSurface = computed((): DaemonSurfaceRecord => {
    const id = activeSandboxId.value;
    return (id === undefined ? undefined : surfaces.value.get(id)) ?? unheardActive.value;
});

const recordOf = (
    routes: readonly string[] | undefined,
    shapes: Readonly<Record<string, string>> | undefined,
    surface: DaemonSurface | undefined,
    raw: Pick<Hello, `rawRoutes` | `rawFingerprints` | `prints`> | undefined,
): DaemonSurfaceRecord => ({
    routes: routes === undefined ? undefined : new Set(routes),
    shapes,
    raw: raw?.rawRoutes === undefined ? undefined : new Set(raw.rawRoutes),
    rawPrints: raw?.rawFingerprints,
    prints: raw?.prints,
    surface: surface ?? `sandbox`,
});

// Called on every hello frame of sandbox `id`; nothing advertised leaves the assume-supported state. A hello that names
// no surface is a daemon's, from before the field.
export const setDaemonRoutesFor = (
    id: string | undefined,
    routes: readonly string[] | undefined,
    shapes?: Readonly<Record<string, string>>,
    surface?: DaemonSurface,
    raw?: Pick<Hello, `rawRoutes` | `rawFingerprints` | `prints`>,
): void => {
    const record = recordOf(routes, shapes, surface, raw);
    // With no sandbox chosen yet, the window's one connection is the one that answered: what it says is the active
    // surface, as it always was.
    if (id === undefined || activeSandboxId.value === undefined) {
        unheardActive.value = record;
    }
    if (id !== undefined) {
        surfaces.value = new Map(surfaces.value).set(id, record);
    }
    sidecarHello = surface === `folder` ? { routes: record.routes, shapes } : undefined;
};

// The active sandbox's hello.
export const setDaemonRoutes = (
    routes: readonly string[] | undefined,
    shapes?: Readonly<Record<string, string>>,
    surface?: DaemonSurface,
    raw?: Pick<Hello, `rawRoutes` | `rawFingerprints` | `prints`>,
): void => setDaemonRoutesFor(activeSandboxId.value, routes, shapes, surface, raw);

// What sandbox `id` last said of its routes; undefined for one whose hello this window has not read.
export const routeSurfaceOf = (id: string): DaemonSurfaceRecord | undefined =>
    id === activeSandboxId.value ? activeSurface.value : surfaces.value.get(id);

const advertised = computed(() => activeSurface.value.routes);
const advertisedShapes = computed(() => activeSurface.value.shapes);
const advertisedRaw = computed(() => activeSurface.value.raw);
const advertisedRawPrints = computed(() => activeSurface.value.rawPrints);
const advertisedPrints = computed(() => activeSurface.value.prints);

// True for a window on a folder of this computer (the desktop app's local face).
export const folderSurface = computed(() => activeSurface.value.surface === `folder`);

// True for a window on a folder whose sidecar runs agents on this computer itself (_devices/host-agents): a folder, and
// a hello that names `agent.run`. Positive evidence only, so a window whose sidecar serves folders alone, or has not said
// yet, offers no chat. What is drawn there is the sandbox's own chat with everything a sandbox alone has left out: no
// private copy and no landing, no fence around the agent, no subagents, automations or schedules.
export const computerAgents = computed(() => {
    const { surface, routes } = activeSurface.value;
    return surface === `folder` && routes?.has(`agent.run`) === true;
});

// Which set names routes of this one's kind: a folder lists the few raw routes it serves among `routes`, a daemon
// advertises them apart. Undefined either way means the surface was never stated.
const advertisedIn = (record: DaemonSurfaceRecord, name: string): ReadonlySet<string> | undefined =>
    isRawRoute(name) && record.surface !== `folder` ? record.raw : record.routes;
const advertisedFor = (name: string): ReadonlySet<string> | undefined => advertisedIn(activeSurface.value, name);

// An unknown daemon or route answers true; a feature only hides on positive evidence it's missing.
// A route a daemon from before a rename advertises under its old name, at the same address: personas became roles on
// 2026-11-18 (roles.contract.ts keeps the paths), so `roles.list` is served by a daemon that says `personas.list`.
// compat(daemon<1.425.0): the roles.* route names (personas.* before the rename)
const formerNameOf = (name: string): string | undefined => (name.startsWith(`roles.`) ? `personas.${name.slice(`roles.`.length)}` : undefined);

const supportedIn = (known: ReadonlySet<string> | undefined, name: string): boolean => {
    const former = formerNameOf(name);
    return known === undefined || known.has(name) || (former !== undefined && known.has(former));
};

export const supportsRoute = (name: string): boolean => supportedIn(advertisedFor(name), name);

// The same question of sandbox `id`; the active one (or none named) as `supportsRoute`, and a sandbox whose hello this
// window never read as supported, as an unknown daemon is.
export const supportsRouteAt = (id: string | undefined, name: string): boolean => {
    if (id === undefined || id === activeSandboxId.value) {
        return supportsRoute(name);
    }
    const record = surfaces.value.get(id);
    return record === undefined || supportedIn(advertisedIn(record, name), name);
};

// Only on positive evidence: the daemon's hello named the route. For a read that stands in for a judgement this window can
// still make for itself (where a turn naming no account runs, the capacity the verdict door reads), where asking a daemon
// that has said nothing yet would only replace a working answer with a pending one.
export const advertisesRoute = (name: string): boolean => advertisedFor(name) !== undefined && supportsRoute(name);

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

// How one route compares: the same, a different core (may misbehave), or a different wire over one core (an optional
// part one side lacks). Read off the second print when the daemon sends it, and off the first, which can only say
// "different", when it doesn't.
type RouteVerdict = "same" | "drifted" | "additive";

interface Comparison {
    // Routes both sides published a print for: the only ones a disagreement can be read off. An unexpressed or
    // unpublished shape is no evidence, not a match.
    readonly compared: readonly string[];
    readonly verdicts: Readonly<Record<string, RouteVerdict>>;
}

const comparison = computed((): Comparison => {
    const contract = contractModule.value;
    const theirPrints = advertisedPrints.value;
    if (contract !== undefined && theirPrints !== undefined) {
        const ours = contract.sandboxRoutePrints();
        const compared = Object.keys(ours).filter((name) => theirPrints[name] !== undefined);
        const verdicts: Record<string, RouteVerdict> = {};
        for (const name of compared) {
            const [ourWire, ourCore] = ours[name] ?? [];
            const [theirWire, theirCore] = theirPrints[name] ?? [];
            verdicts[name] = ourCore !== theirCore ? `drifted` : ourWire !== theirWire ? `additive` : `same`;
        }
        return { compared, verdicts };
    }
    const theirs = theirFingerprints.value;
    if (theirs === undefined) {
        return { compared: [], verdicts: {} };
    }
    const ours = ourFingerprints();
    const compared = Object.keys(ours).filter((name) => theirs[name] !== undefined);
    return { compared, verdicts: Object.fromEntries(compared.map((name) => [name, theirs[name] === ours[name] ? `same` : `drifted`])) };
});

const withVerdict = (verdict: RouteVerdict): string[] =>
    comparison.value.compared.filter((name) => comparison.value.verdicts[name] === verdict).toSorted();

// The denominator a drift count is only meaningful against: "3 routes disagree" says nothing without how many were
// checked, and an old daemon publishing few shapes is checked on few.
export const comparedRouteCount = computed(() => comparison.value.compared.length);

// Routes whose core differs: what has to hold for the call to work is not the same on both sides.
export const driftedRoutes = computed<string[]>(() => withVerdict(`drifted`));

// Routes that answer on both sides alike and differ only in an optional part one of them lacks: a setting the sandbox
// doesn't keep yet, a detail its answer leaves out. Nothing is broken, so on its own this raises no warning; it is
// listed beside one, and the per-call words still name it when a call there is refused.
export const additiveRoutes = computed<string[]>(() => withVerdict(`additive`));

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
    return drifted > comparison.value.compared.length * WHOLESALE_ABOVE ? "wholesale" : "partial";
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
    // An additive route is named too: a refusal there may be the optional part the two sides don't share.
    if (!driftedRoutes.value.includes(name) && !additiveRoutes.value.includes(name)) {
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
