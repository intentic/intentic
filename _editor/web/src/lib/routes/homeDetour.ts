import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { InjectionKey } from "vue";
import type { HistoryState, LocationQuery, NavigationFailure, RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { MODELS_PATH } from "./modelsPath";

// HOME SHOWS A SANDBOX'S VIEW IN PLACE, rather than sending the person into the sandbox for it (2026-10-25). Home is
// the master view: every sandbox at once, each with its chat. A press there that leads to one of a sandbox's own views
// (a notice's "Connect a model", a picker's Connect, "Try again" on a sign-in) used to navigate into the sandbox, and
// the person landed on a page with another rail, no chat, and no way back to where they were. Now any navigation from
// Home to a view listed here stays on Home: the view is drawn where the chat was (features/home/HomeDetour.vue), the
// rail stays, and a labelled Back returns to the chat, which stayed mounted underneath with its draft. The rejected
// alternative was a dialog: a sign-in is a trip to another tab and back, and an address survives that (and a reload),
// where a dialog does not.
//
// One rule at the router (router/index.ts) covers every door at once, today's and the next one's, so no link has to
// know whether it is pressed on Home. Adding a view is one entry here and its component in HomeDetour.vue.

/** The query that names the view Home is showing in its chat's place. */
const HOME_VIEW_QUERY = `show`;

/** The views Home can show in place, each by the in-sandbox address it stands in for. */
export const HOME_VIEWS = [{ key: `models`, inside: MODELS_PATH }] as const;

export type HomeViewKey = (typeof HOME_VIEWS)[number][`key`];

/** The view a Home address shows in its chat's place, if any. */
export const homeViewOf = (query: LocationQuery): HomeViewKey | undefined => {
    const asked = query[HOME_VIEW_QUERY];
    return HOME_VIEWS.find((view) => view.key === asked)?.key;
};

type From = Pick<RouteLocationNormalized, "name" | "path">;
type To = Pick<RouteLocationNormalized, "path" | "query" | "hash">;

/**
 * Where a navigation goes once Home has had its say: from Home to a view it can show, Home itself showing that view, with
 * the target's own query (a provider to open, a sign-in to retry) and hash carried along; anything else, untouched.
 */
export const homeViewFor = (to: To, from: From): RouteLocationRaw | undefined => {
    if (from.name !== `home`) {
        return undefined;
    }
    const view = HOME_VIEWS.find((candidate) => candidate.inside === to.path);
    if (view === undefined) {
        return undefined;
    }
    return { path: from.path, query: { ...to.query, [HOME_VIEW_QUERY]: view.key }, hash: to.hash };
};

// A DELIBERATE STEP INSIDE goes where it names, even onto a view Home would otherwise show in place: a sandbox tile
// pressed twice lands on the screen it was last left on, and that may well be its Models.
// allow(module-state): one step inside at a time per window, read by the navigation it wraps
let steppingInside = false;

/** Runs a navigation that enters the sandbox for real, past Home's rule. */
export const goInside = async (navigate: () => Promise<NavigationFailure | void | undefined>): Promise<void> => {
    steppingInside = true;
    try {
        await navigate();
    } finally {
        steppingInside = false;
    }
};

/** The router's guard: the rule above, except for a step inside. */
export const homeViewGuard = (to: To, from: From): RouteLocationRaw | true => (steppingInside ? true : (homeViewFor(to, from) ?? true));

/** Home's own address again, the view put away: the same sandbox's chat (a phone's `/home/:sandbox`), no query. */
export const homeChatOf = (route: Pick<RouteLocationNormalized, "path">): RouteLocationRaw => ({ path: route.path });

/**
 * Whether leaving the view is a step back in history: the entry before it (the router's own `back`, an address relative
 * to the app's base) is that same chat, as it is whenever the view was opened by a press on Home. Otherwise (a reload, a
 * shared link) leaving replaces the address instead, so Back never walks out of the app.
 */
export const backIsHome = (state: HistoryState, route: Pick<RouteLocationNormalized, "path">): boolean => state[`back`] === route.path;

/** A model a view connected, by the provider and model id a chat's pick names. */
export interface LandedModel {
    readonly provider: AgentProvider;
    readonly value: string;
}

/** What a view Home shows in place is handed, to finish on the chat rather than navigate into the sandbox. */
export interface HomeViewHost {
    /**
     * Back to the chat the view was opened from; given what the view just connected, that chat is pointed at it first
     * when it has nothing to send with and has not started, so its draft goes on what was connected for it.
     */
    readonly back: (landed?: LandedModel) => void;
}

export const HOME_VIEW_HOST: InjectionKey<HomeViewHost> = Symbol(`intentic.home-view-host`);
