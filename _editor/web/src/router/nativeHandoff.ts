import { useTheme } from "@intentic/ui/theme";
import { type DaemonSession, DaemonSessionSchema } from "@intentic/sandbox-contract/schemas/system";
import type { LocationQuery, RouteLocationNormalized, RouteLocationRaw, Router } from "vue-router";
import { z } from "zod";
import { EMBED_QUERY, embedded, LOOK_QUERY, type NativeLook, nativeLook, nativeLookOf, rememberLook, tellNative } from "../app/environments/nativeApp";
import { type ThemeRow, themeRowLook } from "../features/settings/themeRow";
import { returnPath } from "../lib/routes/signIn";
import { AGENT_VIEW, CHANGES_VIEW, mobileChatPath, PHONE_HOME } from "../lib/routes/phoneScreens";
import { useSkin } from "../skins/useSkin";
import { linkedConversation } from "./conversationLink";

// THE ANDROID APP'S HALF OF THE ROUTER (app/environments/nativeApp.ts says what the app is). Installed only in its
// WebView, so a browser gets none of it:
// - a navigation to a screen the app draws itself is handed to it (`intenticNative.open`) and goes nowhere here, whoever
//   started it: a link, a press, a redirect, a guard sending a signed-out reader to /login;
// - the app's back gesture and toolbar ask this page for a step back through `intenticEmbed.back()`, which answers
//   whether there was one, so the app closes the WebView when there was not;
// - the app shows another route in the warm page with `intenticEmbed.open(path)`, hands over the look it wears with
//   `setLook`, and a daemon session it already holds with `adoptSession`.

const CHAT = `/chat`;
const MENU = `/menu`;
const SIGN_IN = `/login`;

/** What the hand-off reads of a route: a guard's and one the router resolved alike. */
export type NativeRoute = Pick<RouteLocationNormalized, `path` | `query` | `fullPath`>;

// What arrives unchecked, from an address or from Kotlin: a word, or vue-router's own history entry.
const WordSchema = z.string().min(1);
const HistoryEntrySchema = z.object({ position: z.number() });

const focused = (query: LocationQuery): string | undefined => WordSchema.safeParse(query[`focus`]).data;

// An agent's own screen (`/agents/<id>`), as opposed to the board or a screen under it (`/agents/<id>/pages/<page>`).
const agentScreen = (path: string): boolean => path.startsWith(`${PHONE_HOME}/`) && !path.slice(PHONE_HOME.length + 1).includes(`/`);

/**
 * The path the app opens for a route it draws itself, undefined for a route this page shows. A conversation is always
 * `/agents/<id>` (the id escaped), however the route named it: `?conversation=`, the board's or the chat's `?focus=`.
 * `/chat` alone is the conversation the chat has open, which only the guard can read, so it comes back as `/chat`. The
 * board, the menu and the sign-in pages keep their whole path, query and all. Two addresses under an agent stay here,
 * since the app shows them in this page: its Changes alone (`/agents/<id>?view=changes`, AgentDetail) and one page it
 * showed, full screen (`/agents/<id>/pages/<page>`, ChatPageScreen).
 */
export const nativeScreen = (to: NativeRoute): string | undefined => {
    const named = linkedConversation(to.query) ?? (to.path === CHAT || to.path === PHONE_HOME ? focused(to.query) : undefined);
    if (named !== undefined) {
        return mobileChatPath(named);
    }
    if (to.path === CHAT) {
        return CHAT;
    }
    const drawn =
        to.path === PHONE_HOME ||
        (agentScreen(to.path) && to.query[AGENT_VIEW] !== CHANGES_VIEW) ||
        to.path === MENU ||
        to.path === SIGN_IN ||
        to.path.startsWith(`${SIGN_IN}/`);
    return drawn ? to.fullPath : undefined;
};

/** The route without the app's two address keys, which the page has read and remembered; undefined when it has neither. */
export const withoutEmbedQuery = (to: Pick<RouteLocationNormalized, `path` | `query` | `hash`>): RouteLocationRaw | undefined => {
    if (!(EMBED_QUERY in to.query) && !(LOOK_QUERY in to.query)) {
        return undefined;
    }
    const { [EMBED_QUERY]: _embed, [LOOK_QUERY]: _look, ...query } = to.query;
    return { path: to.path, query, hash: to.hash, replace: true };
};

/** Whether there is a step back in this page's own history: an entry above the one the app opened it on. */
export const hasStepBack = (position: number | undefined, root: number | undefined): boolean =>
    position !== undefined && root !== undefined && position > root;

/** What the page answers the app with (`window.intenticEmbed`); every argument arrives unchecked from Kotlin. */
export interface IntenticEmbed {
    /** One step back through this page's history, a sheet's own entry included; false when there is none. */
    back(): boolean;
    /** Shows a route in this page without a reload; false for a path it refuses or a screen the app draws. */
    open(path: string): boolean;
    /** Wears one of the four looks over the reader's own choice, without storing it; false for a look it does not know. */
    setLook(look: string): boolean;
    /** Keeps a daemon session the app already holds for a sandbox, so this page needs no sign-in of its own there. */
    adoptSession(sandboxId: string, session: DaemonSession): boolean;
}

declare global {
    interface Window {
        intenticEmbed?: IntenticEmbed;
    }
}

export interface NativeAppHost {
    /** Shows a path the way a link arriving would, a `?sandbox=` in it choosing that sandbox (index.ts `openInPage`). */
    readonly show: (path: string) => Promise<void>;
    /** The conversation the chat has open, which `/chat` means. */
    readonly activeConversation: () => Promise<string>;
    /** Stores a daemon session for a sandbox (sandboxSession.ts `adoptSession`). */
    readonly adoptSession: (sandboxId: string, session: DaemonSession) => void;
    /** Where this page stands in the tab's history: vue-router's `position`, which a sheet's own entry carries too. */
    readonly position?: () => number | undefined;
    /** One step back through the tab's history, the one a sheet listens for. */
    readonly stepBack?: () => void;
}

const historyPosition = (): number | undefined => HistoryEntrySchema.safeParse(globalThis.history?.state).data?.position;

// Both halves of a look at once, as the Theme row stores them, but worn rather than stored.
const wear = (look: NativeLook): void => {
    const row: ThemeRow = look;
    const pair = themeRowLook(row);
    useSkin().hand(pair.skin);
    useTheme().hand(pair.scheme);
};

/** Installs the hand-off, the back the app asks for, and the look it wears; nothing at all outside the app. */
export const installNativeApp = (router: Router, host: NativeAppHost): void => {
    if (!embedded()) {
        return;
    }
    const position = host.position ?? historyPosition;
    const stepBack = host.stepBack ?? (() => globalThis.history.back());
    // The entry the app opened this page on: back never goes below it, since what lies under it is the app's.
    let root = position();
    const canGoBack = (): boolean => hasStepBack(position(), root);

    const look = nativeLook();
    if (look !== undefined) {
        wear(look);
    }

    router.beforeEach(async (to) => {
        const clean = withoutEmbedQuery(to);
        if (clean !== undefined) {
            return clean;
        }
        const screen = nativeScreen(to);
        if (screen === undefined) {
            return true;
        }
        const path = screen === CHAT ? mobileChatPath(await host.activeConversation()) : screen;
        // An app that cannot hear it leaves the page to go there itself, as a browser would.
        return !tellNative({ kind: `open`, path });
    });

    router.afterEach((to, _from, failure) => {
        root ??= position();
        if (failure === undefined) {
            tellNative({ kind: `routed`, path: to.fullPath, title: to.meta.title?.() ?? ``, canGoBack: canGoBack() });
        }
    });

    globalThis.window.intenticEmbed = {
        back: () => {
            if (!canGoBack()) {
                return false;
            }
            stepBack();
            return true;
        },
        open: (asked) => {
            const path = WordSchema.safeParse(asked).data;
            if (path === undefined || returnPath(path) !== path || nativeScreen(router.resolve(path)) !== undefined) {
                return false;
            }
            void host.show(path).then(() => {
                root = position();
            });
            return true;
        },
        setLook: (asked) => {
            const named = nativeLookOf(WordSchema.safeParse(asked).data);
            if (named === undefined) {
                return false;
            }
            wear(named);
            rememberLook(named);
            return true;
        },
        adoptSession: (asked, session) => {
            const sandboxId = WordSchema.safeParse(asked).data;
            const parsed = DaemonSessionSchema.safeParse(session).data;
            if (sandboxId === undefined || parsed === undefined || parsed.expiresAt <= Date.now()) {
                return false;
            }
            host.adoptSession(sandboxId, parsed);
            return true;
        },
    };
};
