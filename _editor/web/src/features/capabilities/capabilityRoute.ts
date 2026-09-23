import type { CapabilitySummary } from "@intentic/api-contract";
import { type CapabilityCatalogEntry, instancesOf } from "@intentic/capability-catalog";
import { computed, type Ref, watch } from "vue";
import type { LocationQueryRaw, RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from "vue-router";
import { isDeviceConnection, machineNamed } from "./model/deviceConnections";

// The page's state is its URL: the open tile (`/capabilities/<entry>`), the connection its form is over (`edit`), the
// slice and filter (`category`, `q`), a machine arriving to be connected (`device`) and the setup walk (`setup`).
// Every move is one pure step from the URL as it stands; the composable reads the page's selection off it.

const PAGE = `capabilities`;
// The walk's mark in the URL.
export const SETUP = `recommended`;

export type PageRoute = Pick<RouteLocationNormalizedLoaded, `params` | `query`>;

export type PageMove =
    // Picking a tile, or walking on to the next one.
    | { readonly kind: `tile`; readonly entry: string }
    // Back to the slice the tile was picked from.
    | { readonly kind: `back` }
    // The form over one of the open tile's connections, or (``) over a new one.
    | { readonly kind: `edit`; readonly id: string }
    // One connection, a click away from its tile: from the Connected slice, or a machine's own row.
    | { readonly kind: `connection`; readonly entry: string; readonly connection: string }
    // The rail's slice or the filter's text.
    | { readonly kind: `filter`; readonly key: `category` | `q`; readonly value: string }
    // Into the walk at its first tile, and out of it once nothing is left.
    | { readonly kind: `walk`; readonly entry: string }
    | { readonly kind: `finish` }
    // A tile slug nothing answers to.
    | { readonly kind: `unknown` };

// Where a move lands, and whether it is a history stop: Back undoes opening a tile, not each keystroke.
export interface PageStep {
    readonly how: `push` | `replace`;
    readonly to: RouteLocationRaw;
}

// What survives leaving a tile: the slice and filter, not the connection being edited, which means nothing elsewhere.
const elsewhere = (route: PageRoute): LocationQueryRaw => ({ ...route.query, edit: undefined });

type Moves = { readonly [K in PageMove["kind"]]: (route: PageRoute, move: Extract<PageMove, { kind: K }>) => PageStep };

// One entry per move; the query carries over (minus `edit`) so Back lands on the same slice.
const MOVES: Moves = {
    tile: (route, { entry }) => ({ how: `push`, to: { name: PAGE, params: { entry }, query: elsewhere(route) } }),
    back: (route) => ({ how: `push`, to: { name: PAGE, query: elsewhere(route) } }),
    // Replaced, not pushed, so reload and Back land correctly: stepping between connections isn't a history stop.
    edit: (route, { id }) => ({
        how: `replace`,
        to: { name: PAGE, params: route.params, query: { ...route.query, edit: id === `` ? undefined : id } },
    }),
    // A machine that only syncs has no connection to open: it lands on the tile's add form with its name carried over,
    // the step it is missing, and the switches stay a decision made there rather than something one click does.
    connection: (route, { entry, connection }) => ({
        how: `push`,
        to: {
            name: PAGE,
            params: { entry },
            query: { ...elsewhere(route), ...(isDeviceConnection(connection) ? { device: machineNamed(connection) } : { edit: connection }) },
        },
    }),
    // Replaced: Back undoes opening a tile, not each keystroke.
    filter: (route, { key, value }) => ({
        how: `replace`,
        to: { name: PAGE, query: { ...elsewhere(route), [key]: value === `` ? undefined : value } },
    }),
    walk: (route, { entry }) => ({ how: `push`, to: { name: PAGE, params: { entry }, query: { ...elsewhere(route), setup: SETUP } } }),
    // Nothing left means the walk is over, back to the catalog it just populated.
    finish: (route) => ({ how: `push`, to: { name: PAGE, query: { ...elsewhere(route), setup: undefined } } }),
    unknown: (route) => ({ how: `replace`, to: { name: PAGE, query: elsewhere(route) } }),
};

// The table is keyed by the move's own kind, so the entry read always takes the move it is handed.
export const pageStep = (route: PageRoute, move: PageMove): PageStep =>
    (MOVES[move.kind] as (route: PageRoute, move: PageMove) => PageStep)(route, move);

export interface RouteHost {
    readonly route: PageRoute;
    readonly router: Pick<Router, `push` | `replace`>;
    readonly entries: Readonly<Ref<readonly CapabilityCatalogEntry[]>>;
    readonly capabilities: Readonly<Ref<readonly CapabilitySummary[]>>;
    // Whether /extensions has answered: a deep-linked connector tile is unknown until it delivers its contribution.
    readonly settled: Readonly<Ref<boolean>>;
}

export const useCapabilityRoute = ({ route, router, entries, capabilities, settled }: RouteHost) => {
    const move = (next: PageMove): void => {
        const step = pageStep(route, next);
        void (step.how === `push` ? router.push(step.to) : router.replace(step.to));
    };
    const queryText = (key: string): string => (typeof route.query[key] === `string` ? route.query[key] : ``);

    // An unknown or absent slug resolves to undefined.
    const selected = computed(() => entries.value.find((entry) => entry.id === route.params[`entry`]));
    const selectedInstances = computed(() => (selected.value === undefined ? [] : instancesOf(selected.value, capabilities.value)));
    // A singleton tile has no list: its one connection IS the tile, so it is always the one being edited.
    const soleInstance = computed(() => (selected.value?.singleton === true ? selectedInstances.value[0] : undefined));
    // The connection the form is over; an unknown or stale `edit` id falls back to adding instead of a blank edit.
    const editing = computed(() => soleInstance.value ?? selectedInstances.value.find((instance) => instance.id === queryText(`edit`)));
    // Derived from the query, not mirrored into refs.
    const scope = computed<string>({ get: () => queryText(`category`), set: (value) => move({ kind: `filter`, key: `category`, value }) });
    const search = computed<string>({ get: () => queryText(`q`), set: (value) => move({ kind: `filter`, key: `q`, value }) });
    const device = computed(() => queryText(`device`));
    const walking = computed(() => route.query[`setup`] === SETUP);

    // An unknown tile slug resolves to no tile, so bounce to the grid, once extensions have settled.
    watch(
        [() => route.params[`entry`], settled],
        ([tile]) => {
            if (typeof tile === `string` && tile.length > 0 && settled.value && selected.value === undefined) {
                move({ kind: `unknown` });
            }
        },
        { immediate: true },
    );

    return {
        selected,
        selectedInstances,
        soleInstance,
        editing,
        scope,
        search,
        device,
        walking,
        move,
        pick: (entry: CapabilityCatalogEntry): void => move({ kind: `tile`, entry: entry.id }),
        back: (): void => move({ kind: `back` }),
        openEdit: (id: string): void => move({ kind: `edit`, id }),
        stopEditing: (): void => move({ kind: `edit`, id: `` }),
        openConnection: (entry: string, connection: string): void => move({ kind: `connection`, entry, connection }),
    };
};
